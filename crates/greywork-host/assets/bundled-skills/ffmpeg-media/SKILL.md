---
name: ffmpeg-media
description: 用 ffmpeg / ffprobe 完成视频剪辑类任务——探测、转码、截取、拼接、抽帧、压缩、提取音轨、生成缩略图。当用户提到「剪视频」「转格式」「截取片段」「抽帧」「压缩视频」「提取音频」「做个封面图」时使用。
---

# ffmpeg 媒体处理

用 `ffmpeg` / `ffprobe` 在命令行完成视频、音频、图片的处理。产物写回工作区，
用户可以直接在文件预览里看结果。

## 先确认环境

```bash
command -v ffmpeg ffprobe || echo "MISSING"
```

缺了就让用户装（本机不代装）：

- Debian/Ubuntu：`sudo apt install ffmpeg`
- macOS：`brew install ffmpeg`
- Windows：`winget install Gyan.FFmpeg`（或下载官方静态构建解压后加 PATH）

`ffprobe` 与 `ffmpeg` 同包，通常一起装好。

## 规矩

1. **先探测再动手。** 任何转码/截取前先跑一次 `ffprobe` 拿到真实时长、
   分辨率、帧率、编码、音轨。凭文件名猜格式是最常见的翻车点。
2. **绝不原地覆盖。** 输出用新文件名（`-y` 只用来覆盖自己的中间产物）。
   用户给的文件是源，改坏了不可逆。
3. **产物落工作区。** 输出路径用相对路径（相对当前工作目录）或工作区内的
   绝对路径，这样预览面板能直接打开。
4. **无损优先。** 纯剪切/拼接优先 `-c copy`（不重编码，秒级完成）；只有确实
   需要改编码参数时才重编码。
5. **命令要能复现。** 报告里给出实际执行的完整命令，用户才能自己微调重跑。

## 探测

```bash
# 人看的概要
ffprobe -hide_banner -i input.mp4

# 机器可读（推荐：交给 jq 取字段，避免正则猜格式）
ffprobe -v error -print_format json -show_format -show_streams input.mp4
```

关注：`format.duration`（秒）、`streams[].codec_type`（video/audio）、
`codec_name`、`width`/`height`、`r_frame_rate`。

## 常见任务

### 截取片段（无损，最快）

```bash
# 从 00:01:30 起截 15 秒，不重编码
ffmpeg -ss 00:01:30 -i input.mp4 -t 15 -c copy out_clip.mp4
```

`-ss` 放在 `-i` **前面**是快速定位（关键帧对齐）；放后面是精确到帧但慢得多。
要精确切割（比如对齐到某一帧）就重编码并去掉 `-c copy`。

### 转码 / 改分辨率

```bash
# H.264 + AAC，缩到 1280 宽（高度按比例），CRF 越小越清晰
ffmpeg -i input.mov -vf "scale=1280:-2" -c:v libx264 -crf 23 -preset medium \
  -c:a aac -b:a 128k out.mp4
```

`scale` 的高度写 `-2` 而不是 `-1`：`-1` 可能算出奇数高度，H.264 会直接报错。

### 压缩体积

```bash
# 目标：明显变小但肉眼可接受。先 CRF 28 试，不够再往上加
ffmpeg -i input.mp4 -c:v libx264 -crf 28 -preset slow -c:a aac -b:a 96k out_small.mp4
```

想精确控制大小（比如压到 10MB）用两遍编码算码率，不要盲猜 CRF。

### 抽帧 / 生成缩略图

```bash
# 第 5 秒的一帧
ffmpeg -ss 5 -i input.mp4 -frames:v 1 out_frame.png

# 每秒一帧，存成序列
ffmpeg -i input.mp4 -vf fps=1 frames/frame_%04d.png

# 九宫格缩略图（需要 ffmpeg 带 tile 滤镜）
ffmpeg -i input.mp4 -vf "fps=1/10,scale=320:-1,tile=3x3" -frames:v 1 out_sheet.png
```

### 拼接同规格片段

```bash
# 前提：所有片段的编码/分辨率/帧率一致。先写清单再 concat
printf "file '%s'\n" clip1.mp4 clip2.mp4 clip3.mp4 > list.txt
ffmpeg -f concat -safe 0 -i list.txt -c copy out_joined.mp4
```

规格不一致时先各自转成统一规格再拼，否则 `-c copy` 会产出损坏文件。

### 提取 / 替换音轨

```bash
ffmpeg -i input.mp4 -vn -c:a copy out_audio.m4a        # 抽原音轨
ffmpeg -i input.mp4 -i bgm.mp3 -map 0:v -map 1:a \
  -c:v copy -c:a aac -shortest out_with_bgm.mp4       # 换背景音乐
```

### 视频转 GIF（短片段才合适）

```bash
ffmpeg -ss 3 -t 4 -i input.mp4 -vf "fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" out.gif
```

### 旋转 / 裁切

```bash
ffmpeg -i input.mp4 -vf "transpose=1" out_rotated.mp4          # 顺时针 90°
ffmpeg -i input.mp4 -vf "crop=640:480:100:50" out_cropped.mp4  # 从 (100,50) 裁 640x480
```

## 排错

- `Unknown encoder 'libx264'`：装的 ffmpeg 没带 H.264。换成发行版完整包，
  或退回 `-c:v mpeg4`（兼容但体积大）。
- `height not divisible by 2`：`scale` 的高度用了 `-1`，改 `-2`。
- 输出文件时长为 0 / 打不开：多半是 `-c copy` 用在了规格不一致的输入上，
  去掉 `-c copy` 重编码一次。
- 中文路径报错：给路径加引号，或用 `-i "$file"` 形式传入。
- 命令跑很久没反应：`-preset slow` + 大分辨率本就慢，可先加 `-t 10` 只处理
  前 10 秒验证参数，确认无误再去掉。

## 交付

- 报告实际命令 + 输入/输出文件名 + 输出时长与体积。
- 顺带把输出文件在工作区里的相对路径写出来，方便用户点开预览。
