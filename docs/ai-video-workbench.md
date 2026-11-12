# AI 视频工作台

这是 OpenFilm 源码中的个人 AI 视频工作台，沿用原有项目文件夹和 Studio 编辑器。界面入口为「视频工作台」。仓库代码采用 [MIT](../LICENSE)，对外发布改版时需要按[商标条款](../TRADEMARK.md)准备独立名称和标识。

## 启动

```sh
nvm use
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @openfilm/desktop start
```

在桌面端选择「工作台」。看板、列表和日历使用同一份作品信息。拖卡片可改状态，也可以打开卡片用表单修改。填入发布平台、作品 URL 和发布时间后，就可以录入快照并比较 T+1、T+3、T+7 数据。

源码桌面端默认使用 `~/.openfilm-dev` 保存工作台数据库。CLI 读取同一套数据时，指定相同的 Studio 主目录。

```sh
export OPENFILM_HOME="$HOME/.openfilm-dev"
export OPENFILM_SHARED_HOME="$HOME/.openfilm"
node packages/openfilm/bin/openfilm.mjs workbench list --json
node packages/openfilm/bin/openfilm.mjs workbench topics today --json
node packages/openfilm/bin/openfilm.mjs workbench video stats <project-id> --json
node packages/openfilm/bin/openfilm.mjs workbench report weekly
```

## 导入快照

先选择作品并保存平台，再在数据面板里导入 UTF-8 CSV。每行需要采集时间和至少一个指标，未知指标可留空。时间支持带时区的 ISO 8601 和毫秒时间戳。

```csv
capturedAt,views,likes,comments,shares,saves,followersDelta
2026-11-12T08:00:00+08:00,1200,68,4,3,7,2
```

同一作品、平台和采集时刻重复导入相同指标会自动跳过。相同时刻的不同指标会提示冲突，整批导入可修正后重试。

## 热点与定时推送

「今日」可以手动刷新抖音和百度榜单、保存选题、录入对标链接和拆解，以及从选题新建项目。推荐会随历史表现和可用的榜单信号更新。

榜单优先直连。自托管了 newsnow 或 DailyHotApi 时，可在 Studio 进程环境配置 `OPENFILM_NEWSNOW_ORIGIN` 和 `OPENFILM_DAILYHOT_ORIGIN`，例如 `http://127.0.0.1:4444`。只有直连失败或过期时才会尝试已配置的备源。

Studio 运行时按北京时间在 08:00 后生成每日摘要。把飞书和企业微信的群机器人地址填入「今日」设置即可启用对应渠道，也可以从 Studio 进程环境设置 `OPENFILM_FEISHU_WEBHOOK` 和 `OPENFILM_WECOM_WEBHOOK`。手动刷新只更新工作台内的摘要。桌面发布包注册 `openfilm://topic/<topicId>`，在安装该桌面包的电脑上打开链接可定位选题。

创作者数据源是实验功能，默认关闭。使用时，在工作台打开独立浏览器，手动登录自己的创作者中心并进入作品数据表，然后从工作台连接。自动导入只匹配表格中可见的完整作品链接与明确标记的累计指标，每天最多尝试一次。会话过期或页面结构变化时，数据源停止同步，已有快照仍可查看和追加。

T+7 复盘通过 Studio 已配置的 OpenAI 服务生成。主动点击生成时，服务会收到该作品的时间线摘要、分镜备注和指标。

## 备份

`.film/production.json` 随项目文件夹移动。指标、选题、对标和任务日志保存在 Studio 主目录的 `workbench.db`。数据库启用了 WAL，正常退出 Studio 和 CLI 后可复制数据库文件。如果仍有 `workbench.db-wal`，或者 Studio 仍在运行，请用 SQLite 在线备份。群机器人地址和创作者浏览器登录态也在 Studio 主目录，备份项目时无需复制它们。
