# 像素北科

北京科技大学学院路校区（海淀区学院路 30 号）的像素风校园地图，含单人与多人游览。

- 斜视角（3/4 俯视）像素画面，1:1 比例，1 米 = 16 像素。
- 地图模式：缩放、拖动、点楼看名称；「走到这里」直接进入游览。
- 游览模式：键盘或触屏摇杆走动，楼宇、水面、树干、校园围栏有碰撞，楼门口可「查看」。
- 多人模式：每组最多 50 人，同组可见、可聊天；单人模式完全离线。
- 季节与昼夜跟随北京时间，也可在设置里切换季节。
- 所有贴图由代码生成，不加载图片素材。

## 本地运行

需要 Bun 与 Node.js 18+。

```sh
bun install
bun run build      # 生成 dist/
bun run start      # http://localhost:8787
```

`bun run dev` 监听源码变化并重新构建，刷新页面即可。

环境变量：`PORT`（默认 8787）、`HOST`、`ROOM_CAP`（每组人数，默认 50）、`TRUST_PROXY=1`（按 `X-Forwarded-For` 计算每 IP 连接数）。

## 操作

| 场景 | 电脑 | 手机 |
|---|---|---|
| 走动 | WASD / 方向键，Shift 跑 | 按住屏幕任意处出现摇杆，推满即跑 |
| 缩放 | 滚轮 | 双指 |
| 查看楼宇 / 地点 | 空格或 E | 右下角「查看」按钮 |
| 聊天 | Enter | 「聊天」按钮 |
| 地图 / 游览切换 | M 或 Esc | 小地图 / 「进去逛逛」 |

链接 `/#x,y`（世界坐标，米）直接在该位置进入游览。

## 目录

```
src/            浏览器端（TypeScript，Canvas 2D，无运行时依赖）
  render/       地面分块、楼宇、树、人物、总览图的程序化绘制
shared/         客户端与服务端共用的二进制协议
server/         零依赖服务端：静态文件 + WebSocket（ws.js 为最小 RFC 6455 实现）
tools/          地图数据生成脚本（Python）
public/data/    生成好的地图数据：campus.json、ground.png
scripts/        构建脚本
```

## 地图数据

`public/data/` 已提交，正常使用不需要重新生成。

重新生成：

```sh
python3 -m venv tools/.venv && tools/.venv/bin/pip install -r tools/requirements.txt
bun run map
```

- 楼宇轮廓、道路、运动场、水面、校园边界、校门：`source/*.osm.pbf`（OpenStreetMap）。
- 地面类型（草地、铺装、沥青、跑道、球场）、树木位置与种类、屋顶颜色、楼名与地点名：北京科技大学官方二维校园地图（瓦片与标注缓存于 `tools/.cache/`）。
- 官方瓦片按标注与 OSM 同名要素做仿射配准（RANSAC），比例尺取自 OSM 坐标。
- 跑道分道线、足球场与单片球场的标线按 OSM 运动场多边形程序化绘制。
- 楼层数：OSM `building:levels`，其次 `tools/build_map.py` 中的 `HEIGHT_OVERRIDES`，再按楼宇类型估计。

`ground.png` 为调色板 PNG，每米 2 格，像素值即地面类型（与 `src/config.ts` 的 `G` 一致）。

## 多人服务

协议见 `shared/protocol.js`：

- 客户端移动时最多每 100 ms 上报一次位置（6 字节），静止时每 5 s 心跳。
- 服务端每 100 ms 向每组广播一次变化的玩家（每人 7 字节），整组共用一个缓冲区。
- 远端玩家延迟 140 ms 插值显示。
- 限制：昵称 12 字，聊天 80 字、每 1.5 s 一条（可连发 3 条），每 IP 6 个连接，70 s 无数据断开。

并入现有 Node/Bun 服务：

```js
import { attachRealtime } from './server/realtime.js';
attachRealtime(httpServer, { path: '/ws', roomCap: 50 });
```

## 许可

代码：GPL-3.0（见 LICENSE）。地图数据 © OpenStreetMap 贡献者，ODbL。楼名与地物参照北京科技大学官方校园地图。
