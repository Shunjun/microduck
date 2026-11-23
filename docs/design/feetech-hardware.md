# 飞特 HD1910 与 IMU firmware-1.0.0

本页负责飞特硬件后端。两套实机驱动各自提供独立模块入口：

- `duck-control/src/xl330/mod.rs` → `duck_control::xl330::DynamixelIo`，原版 XL330。
- `duck-control/src/feetech1910/mod.rs` → `duck_control::feetech1910::FeetechIo`，飞特 HD1910；同目录 `imu.rs` 对接 IMU firmware-1.0.0。

完整文件职责与依赖见[驱动文件关系](hardware-drivers.md)。

通用控制接口保留在 `io.rs`，姿态数据类型保留在公共 `imu.rs`，SFLP 数学解码在公共 `sflp.rs`。主控可为香橙派 Zero 3W；主控系统必须提供可用的串口及其访问权限，
并通过合适的单线半双工 TTL 收发电路连接总线。本驱动不会配置香橙派的引脚复用或设备树。

## 实现范围

`duck-control::feetech1910` 提供串口总线、HD1910 反馈和目标位置写入、IMU 解码及 `RobotIo` 适配器。
`robotd/src/main.rs` 的 `MOTOR_DRIVER` 常量选择实际后端：

```rust
const MOTOR_DRIVER: hardware::MotorDriver = hardware::MotorDriver::Feetech1910;
// 原版：hardware::MotorDriver::Xl330
```

改常量后需要重新编译；启动日志会显示所选驱动。不自动扫描或猜测协议。
串口由 `[bus].port` 或 `--port` 指定，与舵机品牌无关；香橙派配原版 HAT 使用 `/dev/ttyS0`：

```toml
[bus]
port = "/dev/ttyS0"
```

飞特读取 `/etc/robot/feetech1910.json` 的标定。模板在 `deploy/feetech1910.example.json`，
ID 已按原版关节表填写；必须将全部 `null` 替换成实测值。缺少/无效标定时，在打开串口前报错退出。
`--fake`、`--sim` 不需要此标定文件。XL330 保留原有寄存器检查与替换舵机流程；飞特不走该流程。
`microduck_rl` 尚未修改。主控端协议实现与训练模型能否迁移，是两个独立的验证阶段。

支持：

- 1,000,000 baud、8N1、无流控；复用 rustypot 的 v1 包实现，校验和、回包 ID 与设备错误检查。
- `0x82` 同步读取地址 56、长度 15；舵机保持配置顺序，IMU ID 200 总是排最后。
- 每次读取另查地址 90、长度 96 的 IMU 诊断块，要求诊断版本为 1，陀螺仪与四元数年龄不超过 100 ms。
- HD1910 位置、速度、原始负载、电压、温度、硬件状态、移动标志和原始电流反馈。
- `0x83` 批量写目标位置（42..43）与扭矩开关（40）。写目标前校验所有关节，任何一个目标
  非有限或越界时整批拒绝，不裁剪目标。广播写入没有应答，发送成功不代表舵机已执行。
- 打开时只读校验 IMU 版本/型号，以及每个 HD1910 的型号字节 `[10,31]`、位置模式（33=0 或 4）。
  不自动改 ID、模式、EEPROM、零位、速度或加速度。

尚未实机验证，包括全身 50 Hz 时序、通信恢复、角度方向和负载单位。不得把离线测试通过视为步态验证。

## 固定的协议基线

IMU 参考
[firmware-1.0.0 源码](https://github.com/fanhao375/microduck-replica/tree/c8920e60668eead4b966b57847977e31589589a1/hardware/imu_to_dxl/firmware-1.0.0)，
以 `Core/Inc/protocol.h`、`Core/Src/control_table.c` 与 `Tools/imu_probe.py` 为准。
舵机寄存器参考用户已在实机验证可用的
[飞特调试工具 registers.js](https://github.com/Juxi-Technology/FT-ServoController-web/blob/76e2f5f586a28fc0029432339699e7c9914dca20/js/registers.js)。
这里只实现协议与寄存器访问，没有复制固件或网页代码。

| IMU 地址 | 本版本含义 |
| --- | --- |
| 0..1 | 固件版本 1、0 |
| 2 | 小端标志 0 |
| 3..4 | 型号 0x4D44，小端 |
| 5 | ID 200 |
| 56..61 | 三轴陀螺仪 i16 小端，17.5 mdps/LSB |
| 62..67 | SFLP 四元数 xyz，fp16 小端，主机重建 w |
| 68 | 采样计数低 8 位 |
| 69 | bit0 未就绪、bit1 通信失败、bit2 自检失败、bit3 读取过慢 |
| 70 | 保留，必须为 0 |
| 71..76 | 原始加速度（此驱动不消费） |
| 81..84 | 完整采样计数（此驱动使用快读块的低 8 位） |
| 85 | RAM 标记（此驱动不写） |
| 90..185 | 24 个 u32 小端诊断字；174..177 为诊断布局版本 1 |

不采用旧版地址 124 的 IMU 数据布局，也不采用 Dynamixel 2.0 的 CRC/fast sync read。

只统计计数变化的有效样本；连续收到相同计数不会推进 25 个样本的预热。计数 255→0 正常处理。
状态故障、非法四元数、超时/短包、过期诊断或恢复次数变化都会清除就绪状态并重新预热。
没有新样本超过 100 ms 时拒绝该帧。bit3 表示读取过慢，不单独使姿态失效。
全零四元数字节是固件的未就绪标记；负零编码的单位姿态可正常解码。

## 先运行只读检测

在仓库 `microduck` 目录内，使用实际的串口设备路径和舵机 ID：

```sh
cargo run -p duck-control --release --example feetech_probe -- /dev/ttyUSB0 1,2 1,0,0,0
```

最后一项为传感器坐标到机身坐标的单位四元数 `[w,x,y,z]`；`1,0,0,0` 只表示坐标轴一致，
必须按安装方向修改。只接 IMU 时把 `1,2` 改为 `-`。此命令只读取约 5 秒，不开扭矩、不写位置。
它要求指定的每个设备都响应，失败即报错退出，不扫描 ID、不自动修复配置。
串口不能同时被网页调试工具或其他程序占用。

确认 `ready=true`、姿态方向正确、温度/电压合理，并记录所有舵机的原始位置，再开始机械标定。

## 接入控制接口前的标定

`FeetechIo::open(path, Config)` 是提供给控制循环的入口；`Config` 可由 serde JSON 解析。
没有默认的全身校准值，以免把原版硬件的零位、方向和限位带到新机构上。

| 配置项 | 必须提供的实际值 |
| --- | --- |
| `joints` | 15 项，严格按 `duck_control::JOINT_NAMES` 顺序；嘴部也在其中 |
| 每项 `id` | 实际舵机 ID，不得重复或使用 200 |
| `zero_ticks` | 该关节训练坐标为 0 rad 时的编码器值，不是默认站立角度 |
| `direction` | 训练关节轴相对编码器递增方向：+1 或 -1 |
| `min_ticks`、`max_ticks` | 机械安全范围，位于 0..4095，包含零位 |
| `imu_mount` | 安装标定所得单位四元数 |
| `speed_rad_s_per_unit` | HD1910 原始速度单位到 rad/s 的换算，需要手册或测量确认 |
| `current_ma_per_unit` | 原始电流幅值到 mA 的换算，需要手册或测量确认 |

位置换算为 `direction × (ticks − zero_ticks) × 2π/4096`。速度按符号幅值（bit15 为方向）解码，
再乘该关节方向及显式配置的速度单位。电流以原始无符号读数乘显式配置的电流单位；若实机
电流格式与调试页面的无符号读数不同，必须先核实并更新解码。不会把未知电流/速度单位冒充物理单位。

`RobotIo::slow_sensors` 返回最近一次成功快读中的电压和温度，调用前必须有一次成功读数。
`RobotIo::set_gain(kp)` 直接把 P 写入 HD1910，范围为 0..254，不做 XL330 数值换算。
随仓库提供的 `deploy/robotd.toml` 设置 `[policy] gain=180`、`standing_gain_ratio=0.8`，
以及 `[safety] gain_limp=40`：正常运行 P=180，站立 P=144，摔倒 P=40。
这些是运行端配置，需随程序部署；未提供配置时，共享参数库仍使用原版默认值（200、50）。
标定 JSON 不再接受 `gain_scale` 字段，已有文件应删除该字段。
每次调参向地址 21 批量写 P，再读回验证。按用户要求，不主动读写地址 55，不解锁、不加锁，也不额外发送保存命令。
是否掉电保存由舵机现有的地址 55 设置决定：0 为持久保存，1 为仅当前上电期间生效；运行时不替用户改变这个选择。
保留原 D/I。依据为[飞特 STS 内存表地址 55 的定义](https://ftservo.github.io/ftservo-wiki/reference/parameter/memory-sts/)。
官网核对：HD-1910-C001 [产品页](https://www.feetechrc.com/510257)仅列 PID 控制，未公布出厂 P。
官方 [STS 内存表](https://ftservo.github.io/ftservo-wiki/reference/parameter/memory-sts/)中位置 P 为地址 21、1 字节、0..254、比例系数 1/4，默认值为“—”。
这些资料不能推出该型号的出厂 P，亦不能给出它与 XL330 P 的等效比例；默认 P=180 来自用户指定，不是声称它是出厂值或与 XL330 等效。
实际固件上的即时响应、模式 0/4 的增益单位仍需台架验证，读回成功不等于动力学已校准。

`reboot` 尚未实现，明确报不支持，不误发其他协议的命令。真实动作验证前仍需完成：

1. 标定零位、方向、限位、安装方向、速度/电流单位和增益比例。
2. 通过 HAT 测量混合总线最坏时延，确认临时 P 在实际固件上生效。
3. 对齐训练模型的观测、动作、机械质量和舵机动态，必要时重新训练。

## 离线验证

```sh
cargo test -p duck-control
cargo clippy -p duck-control --all-targets -- -D warnings
```

测试覆盖混合总线排序、版本拒绝、读错后清除就绪状态、采样计数回绕、重复采样预热、冻结超时、
实际串口包的校验和/回包 ID/设备错误、非法 fp16、诊断版本、符号幅值/关节单位转换、整批拒绝非法目标和写入地址。
不连接真实串口，不代表已通过 Orange Pi/HD1910 的电气或运动测试。
