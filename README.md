# 见面倒计时

一个私密的双人见面倒计时工具。主界面保留当前照片和毛玻璃设计；鼠标移动会通过 Three.js 灰度位移场直接让背景图片产生轻微水波形变。左右边缘隐藏着录音留言和每日清单，双方通过同一个房间链接实时同步。

生产地址：[meet.luke-xu.asia](https://meet.luke-xu.asia)

当前部署使用 Cloudflare Worker + Static Assets、D1、R2 和 Durable Object WebSocket。房间采用邀请链接模式：打开生产地址后会自动生成一个房间，复制带有 `?room=...` 的地址给另一方即可加入。没有复杂账号系统，知道邀请链接的人可以访问该房间。

## 启动

需要 Node.js 22.5 或更高版本（使用内置 SQLite）。

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

部署前检查和部署：

```bash
npm run deploy:dry
npm run deploy
```

`wrangler.jsonc` 已配置 `meet.luke-xu.asia` Custom Domain；D1 数据库和 R2 bucket 的资源 ID 已绑定到当前 Cloudflare 账户。
