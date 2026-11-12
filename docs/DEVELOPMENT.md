# 开发与维护

## 环境

- Bun（构建、类型检查）、Node.js 18+（服务端）。
- Python 3 与 `tools/requirements.txt`（仅重新生成地图数据时需要）。

```sh
bun install
bun run build      # 生成 dist/
bun run start      # http://localhost:8787
bun run dev        # 监听源码并重新构建，刷新页面生效
bun run check      # tsc --noEmit
bun run map        # 重新生成 public/data/
```

## 结构

| 路径 | 内容 |
|---|---|
| `tools/build_map.py` | 地图数据生成，单文件 |
| `public/data/` | 生成结果，已提交：`campus.json`、`ground.png`、`roofs.webp` |
| `src/data.ts` | 加载并解码三份数据为 `World` |
| `src/render/ground.ts` | 地面分块（256 纹素），含标线 |
| `src/render/buildings.ts` | 楼宇墙面、屋顶贴图 |
| `src/render/view.ts` | 游览视图：排序绘制楼、树、人、围栏、标牌、小物件 |
| `src/render/overview.ts` | 地图模式的总览图 |
| `src/collision.ts` | 碰撞网格 |
| `server/`、`shared/` | 静态文件与 WebSocket 服务、二进制协议 |
| `scripts/build.ts` | 打包、资源加哈希、预压缩 |

## 坐标与单位

- 世界坐标：米，原点在世界框左上角，x 向右，y 向下。
- 坐标轴沿官方地图的轴，相对正东、正南转了 `origin.turn` 弧度（约 1.87°）。
- 经纬度换算只用 `lonLatToWorld`（`src/data.ts`）和 `proj`（`build_map.py`），两者必须一致。
- 游览视图 1 米 = 16 纹素（`PPM`）；总览图 1 米 = 2 像素（`OV_PPM`）。
- 官方地图坐标：最细一级（zoom 1）的像素，约 0.1 米/像素；标注与轮廓都用这个坐标。

## 数据格式

### `ground.png`

- 调色板 PNG，每米 `res` 格（现为 4）。
- 调色板颜色对应地面类型：`build_map.py` 的 `DEBUG_COLORS` 与 `src/data.ts` 的 `PALETTE` 必须逐项一致。
- 类型编号：`build_map.py` 的 `G_*` 与 `src/config.ts` 的 `G` 必须同序。

### `roofs.webp`

- 与 `ground.png` 同一网格，无损，16 色。
- 只有带 `tex` 的楼使用；加载后按楼裁成小图，原图随即释放。

### `campus.json`

| 字段 | 内容 |
|---|---|
| `size`、`res` | 世界尺寸（米）、地面每米格数 |
| `origin` | `lon0`、`lat0`、`mx`、`my`（每度的米数）、`turn`、`x0`、`y0` |
| `campus` | 校园边界，分米，扁平数组 |
| `buildings[]` | `n` 名称、`k` 类型、`h` 高度（米）、`f` 层数、`roof` 屋顶色、`p` 外环（分米，屏幕上顺时针）、`holes`、`campus`、`tex` |
| `lines[]` | `c` 颜色（6 位十六进制）、`w` 宽度（1/16 米）、`l` 折线；折线为首点加逐点位移，单位 1/20 米；按宽度从大到小排列 |
| `props[]` | `k` 种类、`x` `y` `w` `d` 外框（分米） |
| `trees` | 每棵 4 个数：x、y、大小（分米）、种类 |
| `labels`、`gates`、`roads` | `t` 文字、`x` `y`（分米） |

`src/data.ts` 的 `RawCampus` 是这份格式的类型定义，改字段时两边一起改。

## 地图生成流程

`main()` 按以下顺序执行：

1. 读 OSM（`source/*.osm.pbf`，解析结果缓存为 JSON）与官方标注。
2. 粗配准：官方标注与 OSM 同名要素，RANSAC 仿射。
3. 精配准：官方楼宇轮廓与 OSM 楼宇按重叠配对，拟合仿射。
4. 世界坐标转到官方地图的轴上（设置全局 `TURN`）。
5. 下载 zoom 1 瓦片，按 8 像素/米（`WRES`）重采样成工作影像。
6. 楼宇：官方轮廓优先，其余用 OSM；取正、定层数、取屋顶色。
7. 地面分类（色相、饱和度、明度阈值），去除路名文字。
8. 标线：跑道拟合、轴向直线、其余笔画中心线、彩色色带。
9. 树冠下与标线下的地面补全，降采样到 `RES`，清理碎块。
10. 校园外用 OSM 画城市。
11. 树、影长测层数、屋顶贴图、小物件、标注，写文件。

构建时打印的几行是自检：

| 输出 | 正常值 |
|---|---|
| `outlines: 83/87 matches, median residual 3.2 m` | 残差约 3 米（OSM 自身的误差） |
| `scale 0.09897 x 0.09777 m/px` | 两个方向相差约 1.2% |
| `track: … coherence 0.89` | 低于 0.3 时不画分道线；明显下降说明拟合锁错了位置 |

## 缓存

`tools/.cache/`（不提交）：

| 目录 | 内容 |
|---|---|
| `tiles_z1/` | 官方瓦片 |
| `outlines/`、`gadgets/` | 官方轮廓、标注 |
| `osm_*.json` | OSM 解析结果 |
| `warp.png` | 工作影像，调试用 |

- 下载失败会重试 4 次后报错，不写入缓存。
- 官方地图更新后，删除 `tiles_z1/`、`outlines/`、`gadgets/` 再生成。
- 换 OSM 数据：把新的 `.osm.pbf` 放进 `source/`，按文件名排序取最后一个。
- 全量生成约需 4 GB 内存；首次下载约 1700 张瓦片。

## 常见修改

### 改楼层数

在 `build_map.py` 的 `HEIGHT_OVERRIDES` 里按楼名填层数。优先级：OSM `building:levels` → `HEIGHT_OVERRIDES` → 影长 → 按类型的 `DEFAULT_FLOORS`。

### 把某个官方轮廓当作楼宇，或不当作

- 类别整体：`OUTLINE_SORTS`（官方分类码）。
- 单个名称：`OUTLINE_BUILDINGS`。

### 加一种小物件

1. `build_map.py` 的 `PROPS` 加一项：种类 → 匹配官方轮廓名称的正则。
2. `src/data.ts` 的 `Prop['k']` 加上种类名。
3. `src/render/view.ts` 的 `drawProp` 加一个 `case`。

### 加一种地面类型

`build_map.py` 的 `G_*` 与 `DEBUG_COLORS`、`src/config.ts` 的 `G`、`src/data.ts` 的 `PALETTE`、`src/render/ground.ts` 的 `buildTextures`、`src/render/overview.ts` 的 `BASE`，五处都要加。

### 调分类阈值

阈值都在 `main()` 的"ground cover"一段。官方渲染图有烘焙阴影：阴影使明度减半，不改变植物和涂料的色相与饱和度，并让灰色表面偏蓝。因此草地与树冠按饱和度区分，沥青与铺装在阴影内外用不同的明度阈值。

改完后对照 `tools/.cache/warp.png` 检查结果。

## 验证

- `bun run check`。
- 地图数据：连续生成两次，三份文件的哈希应一致。
- 界面：`bun run build && bun run start`，看地图模式与游览模式。`/#x,y` 直接在该坐标（米）进入游览，便于定点查看。
- 多人：开两个标签页，互相可见、可聊天。

## 已知问题

- 校园围栏仍是 OSM 的边界线，西门和北 1 门处没有开口。
- 影长得出的层数未逐栋核对。
- 路名文字按形状识别，形状不直的路面标线可能被一并去掉。
- 路灯、长椅没有数据来源，未加入。
- 小物件没有碰撞。
