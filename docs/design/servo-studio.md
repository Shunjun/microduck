# Servo Studio

`studio` 是独立 Rust/Axum 网页包。现有 mediad 控制台不受替换；新增调试功能的设备操作统一由 robotd 负责。使用步骤、默认端口和启动命令唯一维护于 [studio/README.md](../../studio/README.md)。

## 文件边界

- `studio/src/lib.rs`：嵌入网页资源、JSON 路由、请求大小与同源检查；`rpc.rs`：有超时和大小上限的本机 JSON-RPC 客户端。
- `studio/web/app.js`：关节表和操作流程；`preview.js`：解析既有 duck.bin，按关节轴和父子结构绘制姿态；`style.css`：本页面样式。
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

身体 IMU 的原始样本有单独的新鲜度、计数器、静止窗口和错误，不阻止舵机调试。水平校正使用已确认的安装方向与静态重力计算最小旋转；只修正倾斜，无法从静止重力推断安装前向。它不是头部 IMU 标定。头部 IMU 的读取者由板型决定，保持现有 head_imu.stream 契约。

本实现未在真实机械上验收保持参数和柔顺效果，也未部署至开发板。
