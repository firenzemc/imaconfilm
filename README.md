# filmtool · 哈苏 Imacon FFF 胶卷底片处理工具

> **imaconfilm** —— 一个处理哈苏 Imacon（Flextight）扫描仪输出的 `.fff` 胶片底片文件的工具。
> A tool for developing `.fff` film-negative files scanned on Hasselblad/Imacon (Flextight) scanners.

把 Imacon/哈苏 Flextight 扫描的 `.fff` 底片，自动**去橙色色罩 + 反相 + 按画幅比例裁切**成可用的正片，
浏览器里手动微调，批量导出全分辨率 JPEG / 16-bit 无损 TIFF（内嵌 sRGB，darktable / Lightroom 直读）。

服务跑在本机（Apple Silicon 原生）或本地 Docker/OrbStack，绑定 `0.0.0.0`，**整个 tailnet 都能访问** ——
可以在 Mac、iPhone、其它设备的浏览器里操作。

## 运行

### 方式一：本机直接跑（日常）

```bash
cd filmtool
./run.sh                 # 默认端口 8790
```

默认浏览根目录是仓库根；换根目录：`FILMTOOL_ROOT=/path/to/scans ./run.sh`。

### 方式二：Docker / OrbStack（便于迁移）

```bash
docker compose up -d --build      # 默认把本机家目录 $HOME 挂到 /data
```

默认挂载**当前用户的家目录**，所以同一条命令在任何机器都自动挂对的 home
（devmac → `/Users/devmac`，mbp → `/Users/chao`），**不用预设路径**；在 UI 的
「选择目录…」里进到你的扫描文件夹即可（会记住）。要换范围或挂外置盘：

```bash
FFF_DIR=/Volumes/SSD/film docker compose up -d
```

然后在任意 tailnet 设备打开（用运行机器的 Tailscale IP）：

- `http://<运行机器的 tailscale IP>:8790/`
- 本机：http://localhost:8790/

迁移到另一台机器：`docker save filmtool:latest -o filmtool.tar` → 对方 `docker load -i filmtool.tar`
（或直接 `docker compose up --build` 重建）。**底片数据靠挂载，不进镜像**，镜像只是工具本身。

> 端口 8790 是为了避开本机 8788 上已有的 ai-app-sampler。改端口：`PORT=9000 ./run.sh`。
> 首次运行 `uv` 会自动建虚拟环境装依赖（fastapi / numpy / pillow / tifffile）。

## 操作流程

1. **选目录 / 选文件** —— 顶部「选择目录…」浏览允许根目录下的子目录，选当前要处理的一批底片
   （会记住上次选择）。再点 `001.fff` 等载入；自动解码、估色罩、初步反相、初步分帧。
2. **分帧** —— 横向胶片条上：
   - **比例框（推荐）**：在「比例」里选画幅（`3:2 横` / `2:3 竖` / `4:5` / `6:6` / `6:7` / `6:9` /
     `自定义…`）。比例按 **沿条带 : 跨片** 理解 —— 横画幅选 3:2，竖画幅选 2:3。每帧变成**锁定宽度的
     框**，沿条带拖动对齐每张照片即可；**框之间可留空**，自然避开两帧之间的黑条。双击加框，框上 × 删。
   - **自由(等分)**：保留旧的等分切线模式（双击加切线、拖动调整、切线顶端 × 删除）。
   - **绿色上下线**：既裁掉扫描架 holder 的奶白边，也**定义画幅短边**（被比例放大成长边）；自动检测，可拖。
   - **精细操作**：拖动时按住 **Shift/Alt** 放慢 5 倍；选中后 **←/→** 微调框/切线、**↑/↓** 微调上下线
     （步长 0.001，Shift ×5）；「缩放」滑块放大条带，紧贴的边界也能精修。
3. **调色**（右侧，针对当前选中帧）：
   - `模式` 负片/正片 · `曝光` · `对比度` · `Gamma` · `黑场`
   - **中性吸管**：点画面中应为中性灰/白的地方 → 自动白平衡。
   - **片基吸管**：点帧缝里的橙色清片基 → 重新校准色罩基准。
   - `旋转` / `翻转` 调整方向。`色彩应用到全部帧`：把当前帧的色彩参数复制给整卷。
4. **导出** —— 勾选 JPEG / 16-bit TIFF，点 `导出全部帧`。输出写到**输入文件旁的子目录**
   `<输入目录>/<文件名>/`，命名 `<文件名>-序号`（如 `fff/001/001-01.tiff`）。
   TIFF 为 deflate **无损** + 内嵌 **sRGB ICC**；JPEG 也带 ICC。

## 它是怎么工作的

FFF 是 big-endian TIFF 容器，里面是**未压缩 16-bit 交错 RGB**（Flextight 是三线性 CCD，
直接出 RGB，无需去马赛克）。直接 numpy memmap 读取，不依赖 LibRaw/dcraw。

去色罩 + 反相在**密度（对数）空间**一步完成（参考 darktable negadoctor 模型）：

```
lin = raw - 黑基座(pedestal)
D   = log10(片基 / lin)        # 除以每通道片基 → 同时去橙罩并反相；片基→0
out = (D × 白平衡增益 / Dmax)   # 灰世界白平衡 + 曝光
      → 黑场/对比度/Gamma → sRGB
```

- **黑基座**：扫描仪黑电平（≈3000），先减掉。
- **片基**：取红通道最亮、未饱和的像素（C-41 橙色清片基），作为每通道 Dmin 基准。
  除以它既中和橙罩、又完成反相。
- **白平衡**：对全条带"全通道都亮的近中性高光"做灰世界平衡（避免按单通道百分位
  导致的偏蓝过校正）。可用中性吸管覆盖。
- **正/负片**：按片基的 R/B 比自动判断（橙罩 → 负片），可手动切换。
- **比例框几何**：原生条带 `(H 行=沿条带, W 列=跨片)`；上下线跨度 `dv`、所选比例 `along:across`，
  方形扫描像素下锁定框宽 `du = (along/across) · dv · (W/H)`。

## 文件

```
filmtool/
  fff.py            FFF/TIFF 解码（IFD 解析 + memmap）
  pipeline.py       色彩管线：黑基座/片基估计、密度反相、白平衡、分帧、裁切、定向
  server.py         FastAPI 服务 + REST（目录浏览、路径受限于 FILMTOOL_ROOT）
  static/           浏览器 UI（单页，无构建步骤）
  Dockerfile        容器镜像（python3.13-slim + uv，数据挂载到 /data）
  run.sh            本机启动脚本
docker-compose.yml  挂载 ${FFF_DIR:-./fff} → /data，端口 8790
```

## 已知限制

- **自动分帧只是初猜**：底片画幅近乎相邻、缺少明亮帧缝时纯自动按内容分帧不可靠，
  所以设计成"等分/检测 + 手动拖动"。比例框模式下框的初始位置是均匀排布，需手动拖动对齐。
- 16-bit TIFF 单帧约 80MB（deflate 无损），整卷 6 帧约 500MB，导出需要时间和磁盘空间。
- 输出内嵌 sRGB ICC；`develop` 实际是 gamma 2.2 幂函数编码，sRGB 是足够接近的务实选择。
- **DNG**：暂未提供。线性 DNG 在 Lightroom + darktable 双端的兼容性需逐一验证后才并入，
  当前以"无损 + sRGB TIFF"作为通用母版（darktable / Lightroom 均可直接读取并继续调）。
- 色彩参数目前**每帧独立**（选中帧调、可一键应用到全部），曝光因人而异建议逐帧看。
- OrbStack 下大文件（每条 ≈1.1GB）经 virtiofs memmap 可用但比原生略慢。
