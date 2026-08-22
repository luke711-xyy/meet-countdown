# 见面倒计时

一个运行在本机的私密见面倒计时工具。下一次见面时间、背景图片和模糊度都会保存到本地 SQLite 数据库，不依赖云端账号。

## 启动

需要 Node.js 22.5 或更高版本（使用内置 SQLite）。

```bash
cd /Users/huazhi_luke/Documents/Staffs/meet-countdown
npm start
```

然后打开 [http://127.0.0.1:4321](http://127.0.0.1:4321)。开发时可以使用 `npm run dev` 自动重启服务。

数据库会自动生成在 `data/meet-countdown.sqlite`。第一次启动如果还没有设置，会默认填入 7 天后的时间，打开右上角设置即可修改。
