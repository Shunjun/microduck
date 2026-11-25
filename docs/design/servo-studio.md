# Servo Studio

`studio` 是独立 Rust/Axum 网页包。默认发布包使用 Studio 替代 mediad 网页服务，新增调试功能的设备操作统一由 robotd 负责。mediad 程序与可选服务文件保留。使用步骤、默认端口和启动命令唯一维护于 [studio/README.md](../../studio/README.md)。

## 文件边界

- `studio/src/lib.rs`：嵌入网页资源、JSON 路由、请求大小与同源检查；`rpc.rs`：有超时和大小上限的本机 JSON-RPC 客户端。
- `studio/web/app.js`：五页面路由与配置页；`state.js`：状态订阅、请求匹配、重连；`control.js`：摇杆与实时姿态；`actions.js`：模型导入、编辑及显式激活；`debug.js`/`debug.html`：保留的关节表与标定流程；`preview.js`：解析既有 duck.bin，按关节轴和父子结构绘制姿态；`style.css`：共享主题与框架；`control.css`/`actions.css`/`debug.css`/`settings.css`：对应页面样式。
- `robotd/src/servo_debug.rs`：有界命令队列、执行回执、保持/柔顺/归位、稳定采样、配置备份与原子保存。所有串口操作均在原控制线程执行。
- `duck-control/src/servo_debug.rs`：受限操作与反馈结构、零位计算、静态 IMU 水平校正和显式模拟设备。
- `duck-control/src/feetech1910/debug.rs`：复用现有 FT 传输，逐颗报告舵机异常；调试读数不依赖 IMU。调试启动后端拒绝普通运动接口。

## IPC 和控制状态

协议版本 69 新增 `robot.servoDebug`，参数为含 `op` 的对象。操作：`status`、`enter`、`exit`、`scan`、`mode`（off/hold/follow + p）、`position`（id/ticks）、`gain`（id/p）、`torque`（id/on，网页提供卸力）、`settings`（原顺序 15 个关节）、`home`、`capture`、`save`、`imu_capture`（可选已确认安装 mount）、`imu_save`。参数在 robotd 用严格类型验证。

status 即时读取最近快照，其余命令进入容量 8 的队列。控制线程执行后才回应；过期或调用方已取消的命令不执行。请求等待 9 秒，内部队列期限 8 秒。目标移动的完成通过 moving 和反馈判断，不把“收到请求”报告成“舵机已到位”。

进入后普通策略及意图不能控制舵机。固定/柔顺保持建立当前位置目标后再改变 P 和使能。退出明确卸力，正常策略须重新启用；正在关机收姿时不允许进入。一次断连或卸力失败不应继续追踪旧目标；卸力对仍可响应的设备尽力执行，并逐项报告无法确认的设备。

`--servo-debug` 是 robotd 的装机启动方式：共享原实例锁，没有完整标定和 IMU 仍可启动，只能通过调试接口操作。正常方式则保留完整运动参数校验。

## 标定

调零页的 3D 姿态固定为 DEFAULT_POSITION，调试页才跟随实测关节角。零位公式沿用 [飞特驱动](feetech-hardware.md)，姿态图和保存的数学定义一致。必须有真实稳定采样、明确方向及机械限位；未接/失效关节不允许整机标定。保存保留原配置其他字段，备份后原子替换。

模型采用与 robotctl 相同的 `DUCK` 格式和关节顺序，但资源独立为 `studio/assets/duck.bin`。它从 `microduck_rl/src/mjlab_microduck/robot/microduck/robot_walk.xml` 及其原始 STL 生成，只合并坐标完全相同的顶点，不移动顶点、删减三角面或重新排列面绕序，也不沿用终端模型对内部零件的省略。终端的 `robotctl/assets/duck.bin` 继续保留低模；网页不能使用该资源代替完整 CAD。

从 microduck 仓库根目录重新生成（开发电脑需要 numpy；设备不需要 RL 仓库）：

```sh
python3 scripts/bake-duck-mesh.py \
  ../microduck_rl/src/mjlab_microduck/robot/microduck/robot_walk.xml \
  --detail full --out studio/assets/duck.bin
```

浏览器通过 WebGL 深度缓冲逐像素处理遮挡。不能以三角面平均深度排序代替深度检测：交叠零件的前后关系会在同一三角面内变化。保留双面绘制以支持原始 STL；每个唯一网格只上传一次，重复舵机共享 GPU 缓冲，关节运动只更新刚体变换。渲染不依赖 CDN；未启用 WebGL 时明确提示，硬件操作仍由 robotd 执行。

遮挡回归页为 `studio/tests/preview-depth.html`：从仓库根目录提供静态 HTTP 服务，打开该页面，检查相交深度平面的近端、远端以及交换绘制顺序后的结果。它同时展示真实模型，便于旋转检查。

身体 IMU 的原始样本有单独的新鲜度、计数器、静止窗口和错误，不阻止舵机调试。水平校正使用已确认的安装方向与静态重力计算最小旋转；只修正倾斜，无法从静止重力推断安装前向。它不是头部 IMU 标定。头部 IMU 的读取者由板型决定，保持现有 head_imu.stream 契约。

本实现未在真实机械上验收保持参数和柔顺效果，也未部署至开发板。

## 默认网页服务

正式发布、开发发布、本地 dev-push 三条路径均打包 `bin/studio`、`systemd/studio.service` 和 `systemd/sysusers.d/studio.conf`。服务默认监听 8080，由安装钩子和安装脚本启用，更新器从随包服务文件自动推导重启列表。Studio 没有独立硬件权限，也不自动进入舵机调试模式。

mediad 的 unit 改放在 `optional-systemd/`，避免自动启用或在每次升级时重新启动。安装钩子在启动 Studio 前停用旧机器已有的 mediad。音视频、WebRTC 和旧网页仍在 mediad 中，未迁移到 Studio。该变更只调整仓库发布配置，不自动操作已连接的开发板。


## 伙伴版页面与控制

采用已确认的伙伴版视觉，操控、动作库、自主行动、硬件调试、配置分别路由。所有页面最少铺满屏幕，短页 footer 位于底部。操控页使用剩余视口高度，不按固定比例撑出纵向滚动；状态集中于控制列，伙伴提示浮在预览底部、可关闭并在本次浏览器会话保留。

`/api/session` 为同源 WebSocket，绑定一条长期 robotd 连接，白名单转发已存在的控制/订阅/配置方法，最大单条浏览器消息 16 KiB。10 Hz 订阅实测关节姿态；摇杆每 50 ms 发送一次连续意图，幅度与临时速度上限线性相乘，斜向输入归一化。松手、取消、窗口失焦、隐藏页面、路由离开、全局停止均清零本页摇杆；调试模式下顶栏改为“调试：全部卸力”并在操作前确认，避免将普通停止与卸力混淆；重连不重放运动。断连后不再转发，最后指令由 robotd deadman 过期。浏览器失去心跳 10 秒后桥接退出。持续运动会校验反馈新鲜度，超过 1.5 秒停止发送。

当前控制来源从 `move.source` 展示，不声称独占其他客户端。电量读取 `robot.health.battery`，保留 2S 电压估算的限制；请求往返不是视频延迟；没有数据显示未知。身体状态沿用已摔倒/被抱起/低增益报告，不把“未摔倒”称为“平稳”。`media.js` 按既有 mediad/gst 信令协议连接局域网 WebRTC 视频，默认使用本机 8443，地址在配置页按浏览器保存。仅在明确点击连接后建立媒体会话，切回 3D 或离开页面会关闭。mediad 仍为可选服务，不由 Studio 启动；连接失败明确报告，不显示示意视频。本版不接入远程账户/中继。自主行动只保留入口，不提供伪造任务、日志或 LLM 调用。

## 本地动作库

`studio/src/library.rs` 唯一管理上传文件。默认 `/var/lib/microduck-studio/actions`，可由 `--library-dir` 指定；unit 使用 `StateDirectory=microduck-studio` 提供目录写权限，保持 ProtectSystem 等限制。robotd 读取世界可读的模型，网页服务没有舵机或配置目录写权限。

导入必须同时选择 `.onnx` 和 `manifest.json`。页面显示名称、描述、类型、时长、持续策略槽位，并支持完整 JSON 编辑；未识别字段原样保留。支持 constant 编码的 episodic 动作和 walk/stand perpetual 策略。详细 manifest 契约归 [policy-manifest.md](../policy-manifest.md) 所有。

HTTP API：`GET /api/actions` 列表；`POST /api/actions` 原子导入；`PUT /api/actions/{sha256}/manifest` 校验、备份并保存说明。导入 body 为 4 字节大端 JSON 长度、UTF-8 manifest、ONNX 三段，浏览器直接传 Blob，避免模型 Base64 膨胀。manifest 上限 64 KiB、ONNX 上限 32 MiB；不接收客户端路径。存储键为模型 SHA-256，同模型重复导入拒绝并提示编辑已有说明。先写暂存目录、调用既有 `duck_control::policy::validate` 验证 ONNX 接口，成功后原子发布；失败清理暂存，不生成已安装项。设备需要既有 ONNX Runtime；缺失时报告原因，不能跳过模型检查。

导入/保存不启用任何动作。单次动作须显式经 `robot.setSkill` 注册，之后才可确认试运行；持续策略须显式绑定 `robot.loadPolicy`。运行端现有动作来自 `robot.skills`，不在网页写死列表。移除自定义配置经 `robot.removeSkill`，原版动作恢复默认、模型文件保留。修改 manifest 不修改已注册配置或运行中的策略，需重新注册/绑定。预览插画只是动作图标，不是由模型推演出的动作；3D 只展示实测状态。

硬件选项通过 robotd 的 API 和配置文件管理，机制归 [飞特硬件说明](feetech-hardware.md)；本次协议版本 70，部署须同时更新 robotd 与 Studio。方向与限位在配置页编辑，按原契约先应用会话，采集保存零位时写入设备配置。操控偏好仅保存于当前浏览器并明确标注，不冒充 robotd 的持久化参数。
