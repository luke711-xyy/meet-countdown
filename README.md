# 见面倒计时

一个私密的双人见面倒计时工具。主界面保留当前照片和毛玻璃设计；鼠标移动会通过 Three.js 灰度位移场直接让背景图片产生轻微水波形变。左右边缘隐藏着录音留言和每日清单，双方通过同一个房间链接实时同步。

生产地址：[meet.luke-xu.asia](https://meet.luke-xu.asia)

Cloudflare 版本使用 Worker + Static Assets、D1、R2 和 Durable Object WebSocket。房间采用邀请链接模式：注册或登录后创建房间，再将邀请链接发给另一位注册用户。只有两位房间成员能连接该房间的 WebSocket；邀请链接本身不是登录凭据。

## 启动

需要 Node.js 22.22.2 或更高版本（使用内置 SQLite）。

```bash
cd /Users/huazhi_luke/Documents/Staffs/meet-countdown
npm start
```

然后打开 [http://127.0.0.1:4321](http://127.0.0.1:4321)。开发时可以使用 `npm run dev` 自动重启服务。

数据库会自动生成在 `data/meet-countdown.sqlite`。第一次启动如果还没有设置，会默认填入 7 天后的时间，打开右上角设置即可修改。

## Cloudflare 本地验证

需要已经登录 Wrangler，并使用项目内的远程资源配置：

```bash
npm run dev:cloudflare
```

首次运行本地 Worker 时应用 D1 migration：

```bash
npx wrangler d1 migrations apply meet-countdown-db --local
```

本地 Worker 和迁移就绪后，可运行针对真实 HTTP/WebSocket 接口的自动化检查。测试会在本地 D1 注册随机测试账号、创建和销毁测试房间；测试账号仍留在本地 D1，退出登录会清除测试会话。

```bash
node --test tests/screening-worker.integration.mjs
npm test
```

## 双人放映室的使用边界

- 共享屏幕和开启麦克风都需要本人点击，浏览器随后弹出来源或权限选择。被拒绝的权限不能由网页代为开启。手机等缺少 `getDisplayMedia` 的浏览器可以尝试观看，但不能从该设备发起共享。
- 浏览器和所选共享来源决定能否捕获标签页声音；共享整个屏幕、窗口或受保护内容时可能无声或黑屏。界面会提示没有影片音轨。双方语音需要分别开启麦克风，建议佩戴耳机。
- “暂停/继续”是发给分享者的请求。分享者要自行操作外部播放器并确认；网页不能远程暂停任意网站或播放器。
- 媒体由两台浏览器通过 WebRTC 直连，只使用公开 STUN，不配置 TURN 或媒体中继。受限网络可能无法连通；出现直连失败提示时需要更换网络后重试。Worker 的 WebSocket 只传递信令、控制和短弹幕，画面与通话不经 Worker、D1 或 R2 存储。
- 1080p/30 fps 是起始目标，不是质量保证。真实画质、丢包、抖动和往返时延需要在两端浏览器中通过 WebRTC stats 核实。浏览器限制自动播放时，观看者需要点击“开启声音”。

自动化检查已覆盖本地 Worker 的身份校验、定向信令、设备接管、旧会话、暂停、房间销毁和弹幕限速；它不验证真实屏幕或语音。两端真实媒体的浏览器与网络矩阵尚待人工验收，当前没有可据此宣称通过的浏览器组合。

部署前检查和部署：

```bash
npm run deploy:dry
npm run deploy
```

`wrangler.jsonc` 已配置 `meet.luke-xu.asia` Custom Domain；D1 数据库和 R2 bucket 的资源 ID 已绑定到当前 Cloudflare 账户。
