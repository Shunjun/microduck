# 实机驱动的文件职责与引用关系

本页负责驱动的代码组织。两套入口是 `duck_control::xl330::DynamixelIo` 和
`duck_control::feetech1910::FeetechIo`，都实现公共 `RobotIo` 接口。
`mod.rs` 是子模块声明和对外导出的入口，不存放总线实现。

## 公共层

| 文件（相对 `duck-control/src`） | 职责 |
| --- | --- |
| `lib.rs` | 声明公共模块，导出控制接口和数据类型 |
| `io.rs` | `RobotIo` 接口及 `Sensors`、`JointTargets`、错误和健康数据 |
| `model.rs` | 关节数量/名称/顺序、训练默认姿态、嘴部与电池模型；没有 XL330 寄存器和编码器偏移 |
| `imu.rs` | `ImuData`：角速度、重力方向、四元数的数据类型 |
| `sflp.rs` | 两块 LSM6DSV16X 共用的 12 字节载荷解码、fp16、四元数旋转和中值处理；不保存总线地址或默认安装方向 |

`model.rs` 中的默认姿态是训练坐标中的机器人姿态，不能当成飞特的编码器零位。
XL330 的默认 ID 表由 `xl330/config.rs` 从 `duck-ipc-proto` 导入；crate 根的 `JOINT_IDS`
导出为现有调用方保留，表示原版默认 ID，并不是飞特的标定数据。

## XL330

| 文件 | 职责及直接使用的本地模块 |
| --- | --- |
| `xl330/mod.rs` | 导出 `DynamixelIo`、`replacement_target`，声明 `bus`、`driver`、`config`、`imu` |
| `xl330/bus.rs` | 原版串口连接、启动检查、替换舵机与初始化辅助；使用 `config`、`imu`、公共 `sflp`、`io`、`model` |
| `xl330/driver.rs` | 为 `DynamixelIo` 实现 `RobotIo` 的传感器读写、扭矩、增益与健康查询；使用 `bus`、`config`、`imu`、公共 `io`、`model` |
| `xl330/config.rs` | ID、波特率、寄存器地址、换算参数、工厂设置、膝关节偏移与通信时序；使用公共关节数量 |
| `xl330/imu.rs` | 原版 IMU ID、载荷长度、Zero3/Beta 安装方向、重复数据跟踪；使用公共载荷长度和健康数据类型 |
| `xl330/tests.rs` | 由 `bus.rs` 加载的回归测试；配置不变量测试随 `config.rs` 放置 |

`robotd/src/main.rs` 通过 `xl330/mod.rs` 的导出打开 `bus.rs` 中的 `DynamixelIo`。
安装方向取自 `xl330/imu.rs`；IMU 与默认舵机 ID 也从 XL330 专属模块读取。

## 飞特 HD1910

| 文件 | 职责及直接使用的本地模块 |
| --- | --- |
| `feetech1910/mod.rs` | 导出驱动、总线、配置和反馈类型，提供模块内部的错误构造 |
| `feetech1910/driver.rs` | `FeetechIo` 实现 `RobotIo`，把反馈换成 rad、rad/s、mA；使用 `bus`、`config`、公共 `io`、`model` |
| `feetech1910/bus.rs` | `SerialBus` 负责 FT-SCS 收发；`FeetechBus` 负责身份检查、混合总线读写和 IMU 最后应答；使用 `config`、`feedback`、`imu`、公共 `io` |
| `feetech1910/config.rs` | 关节 ID/零位/方向/限位、IMU 安装方向、速度/电流单位及其校验；使用 `imu`、公共关节数量和错误类型 |
| `feetech1910/feedback.rs` | 从舵机反馈寄存器解码位置、速度、电压、温度等原始数值 |
| `feetech1910/imu.rs` | IMU firmware-1.0.0 的诊断、状态、计数、新鲜度和预热管理；使用公共 `sflp`、`imu::ImuData`、`io` |
| `feetech1910/tests.rs` | 混合总线、标定、故障恢复及虚拟串口测试；由 `mod.rs` 加载 |

只读工具 `duck-control/examples/feetech_probe.rs` 直接调用 `FeetechBus`，不经过
`FeetechIo` 的全身物理单位适配，不发送位置或扭矩命令。
协议基线、标定要求和接入限制见[飞特硬件说明](feetech-hardware.md)。

## 主要调用路径

下列箭头表示调用或使用，不是相互继承：

```text
robotd/main.rs → xl330/mod.rs（导出）→ xl330/bus.rs
  xl330/bus.rs → xl330/config.rs、xl330/imu.rs、公共 sflp.rs
  xl330/driver.rs → xl330/bus.rs 中的 DynamixelIo、config.rs、imu.rs、公共 io.rs

robotd/main.rs → hardware.rs → feetech1910/mod.rs（导出）→ driver.rs
  driver.rs → bus.rs、config.rs、公共 io.rs
  bus.rs → config.rs、feedback.rs、imu.rs
  config.rs → imu.rs（验证安装方向）
  imu.rs → 公共 sflp.rs → 公共 imu.rs（ImuData）

feetech_probe.rs → feetech1910/mod.rs（导出）→ bus.rs
  此路径直接读取总线，不经过 driver.rs。

```

两套驱动都依赖公共 `io.rs` 的接口与数据，使用公共 `model.rs` 的关节语义；
飞特模块没有导入 XL330 模块。`robotd/src/main.rs` 的 `MOTOR_DRIVER` 常量决定使用哪一套；`robotd/src/hardware.rs` 统一分派 `RobotIo` 方法。修改常量后重新编译生效，具体配置见[飞特硬件说明](feetech-hardware.md)。
