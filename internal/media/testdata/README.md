# 媒体回归样本

`chromium-recording.webm` 由本项目自动化 Chromium 的真实 `MediaRecorder` 编码器生成，输入为浏览器的模拟麦克风设备。它是 WebM/Opus、48 kHz、11881 字节；流式容器没有 `format.duration` 字段，解码后音频为 1200 ms。

此样本用于验证服务器接受浏览器实际生成的流式录音，不能作为真机麦克风、iPhone Safari 或跨设备兼容性证据。其他 JPEG/PNG 和音频样本由测试中的编码器生成。
