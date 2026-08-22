# Cloudflare 实时互动版本：调研与方案设计

状态：Phase 1/2 已完成首版实现并部署到 `meet.luke-xu.asia`，继续进行真实双端验收。

视觉方向稿：[cloudflare-realtime-visual-concept-v2.png](./cloudflare-realtime-visual-concept-v2.png)

> 原视觉方向稿 `cloudflare-realtime-visual-concept.png` 已被当前方向替代，仅保留作历史记录。

## 视觉约束：当前截图优先

这一版不重新设计主视觉，直接以当前截图为基准：

- 保留现有背景照片、整体构图、中心倒计时、白色 Apple-like 字体和克制的毛玻璃倒计时面板。
- 不加入霓虹、彩色水体、发光粒子、强烈拖影、科幻光晕或“AI 视觉稿”式的装饰。
- 水波纹不单独显示为一圈彩色线条，而是作为背景照片上的低对比度灰度折射/位移，让照片局部像隔着一层真实玻璃水面发生形变。
- 只有背景图片受水波影响；倒计时文字、中心玻璃面板、设置按钮和左右边缘控件保持稳定，不被扭曲。
- 左右功能在隐藏时只保留透明液态玻璃悬浮球/微弱提示，靠近边缘后才展开，不在中心增加额外卡片和说明文字。

## 一、目标收敛

把当前的本地倒计时升级成一个部署在 Cloudflare 上的双人私密空间：

- 中央仍然是“下次见面时间”的倒计时。
- 双方鼠标在主画面移动时，看到同一片由 Three.js 驱动的水波、液态折射和延时拖影。
- 录音留言与每日任务是辅助信息，不占据主视觉；只有鼠标靠近左右边缘时才展开。
- 隐藏状态只保留两侧的透明液态玻璃提示球，不使用系统弹窗。
- 语义 DOM 仍然是表单、音频、任务列表的真实来源，Three.js 负责实时视觉投影与环境效果。

## 二、成熟方案调研

### 1. Three.js 官方 GPGPU Water

[Three.js GPGPU Water 示例](https://threejs.org/examples/webgl_gpgpu_water.html)已经验证了“鼠标移动/点击扰动水面”的基本路径。它适合提供局部冲击波、波面扩散和衰减的物理基础，但不直接解决双人同步、液态玻璃或拖影风格。

结论：作为水波的参考模型，不直接照搬整套场景。

### 2. `three-fluid-fx`

[artcodev/three-fluid-fx](https://github.com/artcodev/three-fluid-fx)提供可接入普通 Three.js 的实时流体求解器，包含 `WaterDistortionPass`、`WaterCausticsDistortionPass`、`TrailOverlayPass` 等效果，并支持 WebGL/GLSL 与 WebGPU/TSL 两条路径。

结论：第一版优先采用 WebGL2/GLSL，只取其水面位移/折射思路。关闭彩色染料、光晕和显眼的 `TrailOverlayPass`，不把 WebGPU 支持风险放进首个版本。

### 3. `three-html-render` 与 HTML-in-Canvas

[repalash/three-html-render](https://github.com/repalash/three-html-render)实现了 WICG HTML-in-Canvas 的 polyfill，并提供 `HTMLTexture`、`InteractionManager` 和 `RaycastInteractionManager`。它可以让真实 DOM 以纹理形式进入 Three.js，同时保留 hover、focus、表单和文本选择能力。

但 [Chrome 官方说明](https://developer.chrome.com/blog/html-in-canvas-origin-trial?hl=en)明确指出，Chrome 148–150 的原生 HTML-in-Canvas 仍处于早期阶段，需要 Canary/flag 或 Origin Trial。因此本项目不采用“纯原生 HTML-in-Canvas 才能运行”的架构。

结论：采用“hybrid polyfill + DOM overlay”模式：

- Three.js canvas：承载水面、光晕、双人指针、拖影和背景折射。
- HTMLTexture/three-html-render：只用于少量可被液态材质包裹的视觉卡片。
- DOM overlay：保留录音、音频播放、任务编辑、键盘操作和无障碍语义。
- 能力检测失败时，视觉层降级为普通 WebGL canvas，功能层完全可用。

### 4. Cloudflare Edge Chat Demo / Durable Objects WebSocket

[Cloudflare Edge Chat Demo](https://github.com/cloudflare/workers-chat-demo)采用“一个房间对应一个 Durable Object”的模型：WebSocket 连接进入房间，实时事件直接广播，历史记录单独持久化。Cloudflare 官方文档也推荐 [Durable Objects 的 WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)，在空闲时让对象休眠但保持客户端连接。

结论：一对情侣对应一个 `CoupleRoom` Durable Object：

- 鼠标事件只在 DO 中转发，不写数据库。
- 录音留言、任务变更和倒计时设置写入 D1/R2 后再广播事件。
- 使用 hibernation，避免两个人长时间打开页面时持续占用 DO 内存计费。

## 三、建议的最终架构

```text
Browser A / Browser B
        │
        ├── HTTPS /api/* ─────────────── Worker
        │                                  │
        │                                  ├── D1：房间、倒计时、任务、留言元数据
        │                                  ├── R2：音频文件、背景图片
        │                                  └── CoupleRoom Durable Object
        │                                       └── WebSocket 广播实时指针/事件
        │
        └── WebSocket /room/:roomId ─── CoupleRoom DO
```

部署形态建议采用 Cloudflare Worker + Static Assets：静态 HTML/CSS/JS 和 Worker API 一次部署，使用 Wrangler 的 `assets.directory` 与 `ASSETS` binding。参考 [Cloudflare Static Assets](https://developers.cloudflare.com/workers/static-assets/)。

### 数据边界

| 数据 | 存储 | 实时广播 | 说明 |
|---|---|---:|---|
| 下次见面时间 | D1 | 是 | 写入后广播 `countdown.updated` |
| 每日任务文字/状态 | D1 | 是 | 以任务 ID 做幂等更新 |
| 录音留言元数据 | D1 | 是 | 发送者、创建时间、时长、R2 key |
| 录音二进制 | R2 | 否 | 只广播可播放的对象 URL/token |
| 当前鼠标轨迹 | Durable Object 内存 | 是 | 不落库，断开后自然消失 |
| 背景图 | R2 | 是 | 使用对象 key，不把大图 base64 放进 D1 |

R2 上传采用 Worker 生成短时 presigned PUT URL，浏览器直接上传，避免音频先经过 Worker。Cloudflare 官方文档说明 presigned URL 可限制到单个对象和单个 PUT 操作，并建议限制 Content-Type 与 CORS：[R2 Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)。

## 四、实时水波交互设计

### 画面层

1. 将当前背景图片作为 `THREE.Texture` 放到全屏平面上，主界面 DOM/玻璃面板在其上方保持原布局。
2. 用两个 ping-pong render target 保存低分辨率的灰度高度场/速度场；鼠标落点只写入径向 impulse，之后由 shader 扩散、衰减。
3. 背景片元 shader 读取邻域高度差，生成极轻的法线偏移，只改变采样背景图片的 UV：`uv += normal.xy * displacementStrength`。
4. 不绘制彩色水波线、不做 additive glow、不叠加彩色 trail；拖影只表现为上一帧位移场缓慢衰减后的照片变形。
5. 远端交互沿相同的灰度位移场重放，局部保留一点时间差即可；不显示额外的姓名标签或彩色光点。

### 网络策略

不把每一个 `pointermove` 原样发送到服务器。客户端本地 60fps 运行模拟，网络只发送：

- 12–20Hz 的采样点；
- `x/y`、速度方向、速度大小、时间戳、指针状态；
- 每 50–80ms 批量发送一次；
- 断线时只保留本地效果，重连后发送一次 presence，不补发旧轨迹。

这样既能让对方看见连续的背景形变，也不会把 WebSocket 变成高频鼠标日志通道。Cloudflare 文档同样建议对高频 WebSocket 消息做批处理，减少每条消息的运行时切换成本。

### html-in-canvas 选型

本项目的选定模式：`polyfill + overlay`。

- `canvas[layoutsubtree]` 内只放可被捕获的视觉卡片副本。
- 真正的任务按钮、输入框、录音按钮保留在透明/半透明 DOM 层。
- 能力检测：`HTMLCanvasElement.prototype.drawElementImage`、`texElementImage2D`、`copyElementImageToTexture`。
- 原生能力存在时走 Three.js HTMLTexture；否则走 three-html-render polyfill。
- 两条路径共享同一份 DOM state，不允许 canvas 纹理成为唯一交互来源。

## 五、左右边缘功能设计

### 左侧：录音留言

隐藏时：一个 42–48px 的透明液态玻璃悬浮球，显示未读数量或一条很短的波形亮线。

鼠标靠近左侧 88px 区域时：

- 悬浮球向内移动，展开为错落排列的留言卡片；
- 卡片只有发送者标识、时间、播放进度和波形；
- 点击悬浮球开始录音，再次点击结束；
- 最长 60 秒，超过时自动停止；
- 录音中使用 AudioWorklet/AnalyserNode 做轻量实时波形，录音文件用 MediaRecorder 生成；
- 停止后先本地预览，确认发送后才上传 R2。

[MDN MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)是第一版录音实现基线；录音波形和低延迟处理可参考 [MDN AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)。浏览器支持 `audio/webm`、`audio/mp4` 等格式时动态选择，不写死单一编码。

### 右侧：每日任务

隐藏时：一个透明液态玻璃悬浮球，显示今天未完成任务数和一条微弱的完成环。

鼠标靠近右侧 88px 区域时：

- 展开为 3–6 张错落的任务卡；
- 卡片允许完成/取消完成、添加一条任务、删除自己的任务；
- 不展示说明性副标题，不添加“今日任务”“任务管理”等多余标签；
- 每张卡只保留任务文字、完成状态和轻量时间标识；
- 对方完成后通过 WebSocket 立即反映，完成状态使用一条细线/低饱和填充变化，不弹窗。

### 错落感规则

- 不是随机散乱：根据任务 ID 做稳定的 `translateY` 与轻微旋转，让刷新后位置不跳。
- 卡片宽度 188–260px，纵向间距 12–20px。
- 液态玻璃只用在边缘功能卡片，不把整页做成模糊玻璃。
- 侧栏展开/收起用 180–240ms ease-out，尊重 reduced-motion。

## 六、录音与任务的数据模型

```sql
rooms(id, created_at, countdown_at, background_key, updated_at)
members(id, room_id, display_name, role, session_hash, created_at)
tasks(id, room_id, author_id, text, completed, completed_by, created_at, updated_at)
voice_notes(id, room_id, author_id, r2_key, mime_type, duration_ms, created_at)
```

实时事件 envelope：

```json
{
  "type": "task.updated",
  "roomId": "room_…",
  "eventId": "uuid",
  "actorId": "member_…",
  "createdAt": "2026-08-23T00:00:00.000Z",
  "payload": { "taskId": "task_…", "completed": true }
}
```

所有持久化变更都带 `eventId`，Worker/DO 以它做幂等处理；指针事件不进 D1。

## 七、隐私与配对

第一版不强制接入复杂账号系统，采用“房间邀请链接 + 双方显示名 + 签名 session cookie”：

- 创建房间返回一次性邀请链接；
- 第二个人打开链接后加入同一个 room；
- Worker 只把 room ID 的哈希和签名 session 放入 cookie；
- API 与 WebSocket 都验证 session，不把原始邀请 token 长期存储；
- 录音对象 key 使用 room 前缀并随机化，不能通过猜路径访问。

后续如果需要跨设备账号，再接入 Cloudflare Access 或第三方身份系统，不把账号系统和第一版视觉互动绑定在一起。

## 八、实施分期

### Phase 1：Cloudflare 骨架

- Worker Static Assets
- D1 schema/migrations
- CoupleRoom Durable Object + hibernating WebSocket
- 房间配对、倒计时读写、真实部署 smoke test

### Phase 2：Three.js 实时视觉

- WebGL2 fluid baseline
- ripple impulse、延时 trail、远端 pointer replay
- 背景图 R2 化
- 60fps 本地模拟、12–20Hz 网络采样
- Safari/Chrome/移动端 fallback 验证

### Phase 3：低存在感功能

- 左侧录音留言：录音、预览、上传、播放、未读球
- 右侧任务：创建、完成同步、错落玻璃卡
- 无弹窗通知、reduced-motion、键盘与触摸 fallback

### Phase 4：上线质量

- 两个真实浏览器同时在线验收
- 断线/重连/刷新/重复提交验收
- R2 对象访问权限与 CORS 验收
- Worker、DO、D1、R2 的错误日志与基础限流
- Wrangler deploy 后，从生产域名读回真实 API 与 WebSocket 状态

## 九、验收标准

- 双方打开同一邀请链接后，倒计时和背景设置一致。
- A 移动鼠标，B 在 100–250ms 内看到相同方向的拖影/水波；断网时 A 仍然流畅。
- 任务完成在另一端更新，不弹系统提示。
- 录音可以在浏览器中预览，发送后另一端可播放，刷新后仍存在。
- 左右侧功能默认不抢注意力；靠近边缘才展开，离开后收起。
- 原生 HTML-in-Canvas 不可用时，核心功能不丢失，只降级视觉材质。

## 十、当前建议

先按这个方案实现 Phase 1 + Phase 2 的“背景图片位移版本”，优先确认两个人同时在线时的延迟、照片形变强度和手机端耗电，再接入录音与任务侧栏。实现时保留 DOM overlay 作为真实交互来源，Three.js/HTML-in-Canvas 只负责把现有界面放进实时渲染管线，不改变当前产品气质。
