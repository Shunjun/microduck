# Servo Studio

`studio` 是独立 Rust/Axum 网页包。默认发布包使用 Studio 替代 mediad 网页服务，新增调试功能的设备操作统一由 robotd 负责。mediad 程序与可选服务文件保留。使用步骤、默认端口和启动命令唯一维护于 [studio/README.md](../../studio/README.md)。

## 文件边界

- `studio/src/lib.rs`：嵌入网页资源、JSON 路由、请求大小与同源检查；`rpc.rs`：有超时和大小上限的本机 JSON-RPC 客户端。
- `studio/frontend`：React/TypeScript 网页，五页面路由、配置与首次标定引导。使用实际 shadcn/ui 组件和 Tailwind；全局 CSS 仅维护共享主题及基础样式。WebGL 与媒体引擎负责网格姿态绘制及 WebRTC 信令，页面由 React 管理生命周期。
- `studio/web-dist`：前端构建产物，由 Rust 嵌入；发布/开发打包先构建前端，设备无 Node 依赖。旧 DOM 页面不再提供 HTTP 路由。
- `robotd/src/servo_debug.rs`：有界命令队列、执行回执、保持/柔顺/归位、稳定采样、配置备份与原子保存。所有串口操作均在原控制线程执行。
- `duck-control/src/servo_debug.rs`：受限操作与反馈结构、零位计算、静态 IMU 水平校正和显式模拟设备。
- `duck-control/src/feetech1910/debug.rs`：复用现有 FT 传输，逐颗报告舵机异常；调试读数不依赖 IMU。调试启动后端拒绝普通运动接口。

## IPC 和控制状态

协议版本 69 新增 `robot.servoDebug`，参数为含 `op` 的对象。操作：`status`、`enter`、`exit`、`scan`、`mode`（off/hold/follow + p）、`position`（id/ticks）、`gain`（id/p）、`torque`（id/on，网页提供卸力）、`settings`（原顺序 15 个关节）、`home`、`capture`、`save`、`units`（显式速度/电流单位）、`finish`（校验并结束装机）、`set_zero`（id/ticks，单关节软件零位持久化）、`imu_capture`（可选已确认安装 mount）、`imu_save`。参数在 robotd 用严格类型验证。

status 即时读取最近快照，其余命令进入容量 8 的队列。控制线程执行后才回应；过期或调用方已取消的命令不执行。请求等待 9 秒，内部队列期限 8 秒。目标移动的完成通过 moving 和反馈判断，不把“收到请求”报告成“舵机已到位”。

进入后普通策略及意图不能控制舵机。固定/柔顺保持建立当前位置目标后再改变 P 和使能。退出明确卸力，正常策略须重新启用；正在关机收姿时不允许进入。一次断连或卸力失败不应继续追踪旧目标；卸力对仍可响应的设备尽力执行，并逐项报告无法确认的设备。

缺少或无效飞特标定时，普通 robotd 自动进入装机状态，保持原实例锁和唯一串口所有权，不创建正常运动输出。移除额外的 `--servo-debug` 开关。标定未完成、总线等待连接或正在重连时，配置和最近状态仍可查询；不可执行的调试请求明确报错，不让用户只能等待队列超时。网页初次连接检测 `calibration_required` 后进入引导：选择硬件/串口、只读检查、确认方向与机械限位、摆标准姿态采集保存、独立身体 IMU 标定、核对必要单位、明确完成。进度以设备当前数据为准。

装机过程保存的 JSON 带有 `commissioning_pending: true`，因此即使参数已填齐，未明确完成时重启仍停留在引导。`finish` 要求已保存的完整配置通过运动后端校验，且没有未保存的姿态、关节或 IMU 候选。执行并确认卸力后移除待完成标记，再请求控制线程重新打开正常 IO，清除运动意图；完成不自动使能。配置文件中的速度/电流单位和 IMU 安装前向不填造默认值，缺失时显示阻塞原因。端口变更、CLI 覆盖及有效/已保存参数的规则由 [飞特硬件说明](feetech-hardware.md) 负责。

## 标定

“将当前姿态设为零位”保留一键采集并保存：确认后依次执行 capture/save，采集失败不写入。调零页的 3D 姿态固定为 DEFAULT_POSITION，调试页才跟随实测关节角。零位公式沿用 [飞特驱动](feetech-hardware.md)，姿态图和保存的数学定义一致。必须有真实稳定采样、明确方向及机械限位；未接/失效关节不允许整机标定。保存保留原配置其他字段，备份后原子替换。

摆姿标定保存后，选中关节可在卸力状态下输入编码器零位并单独保存（`set_zero`）。服务端读取已保存配置，只更新该 ID 的 `zero_ticks`，其他关节、IMU 和未知字段保持原样；未保存的其他关节会话设置不会顺带落盘。选中关节的方向、限位须与已保存配置一致；同时校验零位和标准姿态目标的编码器范围及机械限位。保存先更新会话配置，写文件失败则恢复会话；成功时清除旧采集候选和目标，不发送位置/力矩命令。沿用原子保存与备份，回归零位使用更新后的偏移。部署须同时更新 robotd 和 Studio（API 71）。

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

正式发布、开发发布、本地 dev-push 三条路径均打包 `bin/studio`、`systemd/studio.service` 和 `systemd/sysusers.d/studio.conf`。服务默认监听 8080，由安装钩子和安装脚本启用，更新器从随包服务文件自动推导重启列表。Studio 没有独立硬件权限；缺少标定时显示引导，由 robotd 的装机状态限制普通控制。

mediad 的 unit 改放在 `optional-systemd/`，避免自动启用或在每次升级时重新启动。安装钩子在启动 Studio 前停用旧机器已有的 mediad。音视频、WebRTC 和旧网页仍在 mediad 中，未迁移到 Studio。该变更只调整仓库发布配置，不自动操作已连接的开发板。


## 伙伴版页面与控制

采用已确认的伙伴版视觉，操控、动作库、自主行动、硬件调试、配置分别路由。所有页面最少铺满屏幕，短页 footer 位于底部。操控页使用剩余视口高度，不按固定比例撑出纵向滚动；状态集中于控制列，伙伴提示浮在预览底部、可关闭并在本次浏览器会话保留。

操控页的 3D 预览用 `robot.state.joints` 驱动关节，用 `robot.state.imu.quat`（身体到世界、`[w,x,y,z]`）驱动躯干根节点。先验证有限且非零并归一化，且实时帧新鲜、`robot.health.imu` 已就绪、未缺失、连续失效块少于 25 才更新朝向；异常时保留最后有效朝向并提示，未收到有效 IMU 时只有关节姿态。地面和观察相机不随身体旋转；重置视角不重置 IMU。航向以传感器开机参考为准，不代表绝对北向，也不推算平移。头部由关节链驱动，不叠加头部 IMU；调零页保持固定标准参照。

视频模式隐藏 3D 的重置/展开按钮，使用视频原生控件。操控页快捷动作取 `robot.policies` 的已加载动作和 `robot.skills.built_in` 的可用内置能力，策略未启用或无已加载动作时显示空状态，不把配置表里的默认动作当成已就绪模型。原版动作显示中文名称，发送请求仍使用原始标识。

`/api/session` 为同源 WebSocket，绑定一条长期 robotd 连接，白名单转发已存在的控制/订阅/配置方法，最大单条浏览器消息 16 KiB。10 Hz 订阅实测关节姿态；摇杆每 50 ms 发送一次连续意图，幅度与临时速度上限线性相乘，斜向输入归一化。松手、取消、窗口失焦、隐藏页面、路由离开、全局停止均清零本页摇杆；调试模式下顶栏改为“调试：全部卸力”并在操作前确认，避免将普通停止与卸力混淆；重连不重放运动。断连后不再转发，最后指令由 robotd deadman 过期。浏览器失去心跳 10 秒后桥接退出。持续运动会校验反馈新鲜度，超过 1.5 秒停止发送。

当前控制来源从 `move.source` 展示，不声称独占其他客户端。电量读取 `robot.health.battery`，保留 2S 电压估算的限制；请求往返不是视频延迟；没有数据显示未知。身体状态沿用已摔倒/被抱起/低增益报告，不把“未摔倒”称为“平稳”。`media.js` 按既有 mediad/gst 信令协议连接局域网 WebRTC 视频，浏览器连接 Studio 同源 `/api/video`，由 Studio 转发到本机回环地址的视频服务，默认 `ws://127.0.0.1:8443`；页面不提供地址编辑，也不读取旧浏览器自定义地址。仅在明确点击连接后建立媒体会话，切回 3D 或离开页面会关闭。mediad 仍为可选服务，不由 Studio 启动；连接失败明确报告，不显示示意视频。本版不接入远程账户/中继。自主行动只保留入口，不提供伪造任务、日志或 LLM 调用。

## 本地动作库

`studio/src/library.rs` 唯一管理上传文件。默认 `/var/lib/microduck-studio/actions`，可由 `--library-dir` 指定；unit 使用 `StateDirectory=microduck-studio` 提供目录写权限，保持 ProtectSystem 等限制。robotd 读取世界可读的模型，网页服务没有舵机或配置目录写权限。

导入必须同时选择 `.onnx` 和 `manifest.json`。页面显示名称、描述、类型、时长、适用策略，并支持完整 JSON 编辑；未识别字段原样保留。支持 constant 编码的 episodic 动作、walk/stand perpetual 策略、posture_flag 编码的 sitstand 和 phase 编码的 ground_pick。单次动作可选 kick_left、kick_right 或 roulade 槽位；持续策略必须声明适用槽位。详细 manifest 契约归 [policy-manifest.md](../policy-manifest.md) 所有。

策略绑定位于动作库「策略」页签，与「模型」列表分开。下拉框按槽位、类型和指令编码筛选，显示别名或模型名称，不显示设备路径。多个模型可以声明同一槽位，运行端一次绑定一个；更换需确认，等待运行端确认加载后才报告成功。

单次动作收藏与所有模型的显示别名存放在各动作目录的 `studio.json`，由 `/api/actions/{id}/favorite` 和 `/api/actions/{id}/alias` 原子保存，使用与模型导入相同的同源限制和设备端互斥锁。两项互不覆盖，也不写入训练 manifest；空别名回退到原标识。操控页显示已收藏的模型，未注册或路径不匹配的动作禁用，调用仍发送原 manifest.name。

操控页的启动开关读取 `robot.policies.control_enabled`，不以模型配置的 enabled 代替运行状态。开启调用 `robot.enable`，关闭调用 `robot.relax`；摇杆、平移和动作仅在控制开启且设备就绪时可用。固定动作与收藏动作分区，sit_toggle 按 sitting 状态显示坐下或起立。预览相机正俯仰表示地板上方，默认约 17°，可拖动范围 −30° 至 70°。

HTTP API：`GET /api/actions` 列表；`POST /api/actions` 原子导入；`PUT /api/actions/{sha256}/manifest` 校验、备份并保存说明。导入 body 为 4 字节大端 JSON 长度、UTF-8 manifest、ONNX 三段，浏览器直接传 Blob，避免模型 Base64 膨胀。manifest 上限 64 KiB、ONNX 上限 32 MiB；不接收客户端路径。存储键为模型 SHA-256，同模型重复导入拒绝并提示编辑已有说明。先写暂存目录、调用既有 `duck_control::policy::validate` 验证 ONNX 接口，成功后原子发布；失败清理暂存，不生成已安装项。设备需要既有 ONNX Runtime；缺失时报告原因，不能跳过模型检查。

导入/保存不启用任何动作。单次动作须显式经 `robot.setSkill` 注册，之后才可确认试运行；持续策略须显式绑定 `robot.loadPolicy`。`robot.skills` 是可编辑的配置记录；操控页结合 `robot.policies` 的启用状态与动作名以及实时健康反馈显示快捷动作，不把关闭策略时的默认配置当作可执行动作。列表不在网页写死。移除自定义配置经 `robot.removeSkill`，原版动作恢复默认、模型文件保留。修改 manifest 不修改已注册配置或运行中的策略，需重新注册/绑定。预览插画只是动作图标，不是由模型推演出的动作；3D 只展示实测状态。

硬件选项通过 robotd 的 API 和配置文件管理，机制归 [飞特硬件说明](feetech-hardware.md)；当前协议版本 73，部署须同时更新 robotd 与 Studio。方向与限位在配置页编辑，按原契约先应用会话，采集保存零位时写入设备配置。操控偏好仅保存于当前浏览器并明确标注，不冒充 robotd 的持久化参数。


## 外设配置

Studio 的硬件页通过 `robot.peripherals` / `robot.setPeripherals`（IPC API 73）读取及原子保存
麦克风、扬声器、摄像头选择。它们分别写入 `[audio] microphone_device`、`speaker_device`、
`volume` 和 `[media] camera_device`、`quality`。未设置的设备选择沿用既有板级默认；明确填写的
ALSA PCM 不进行缺卡回退。任一选择为 `none` 只关闭对应通路；摄像头关闭时不打开设备、不连接
模拟相机，也不生成测试图。明确保存的麦克风、扬声器选择各自决定是否启用；`[audio] enabled`
仅为没有独立选择的旧配置提供默认值。旧配置禁用的通路在接口中显示为 `none`，用户选择设备即可
启用该通路，不需要另行修改隐藏开关。明确选择非 `none` 摄像头时，同一保存事务将
`media.source` 设为 `camera`；仅修改音频或选择 `none` 不改写原有视频来源。

列表来自 `/proc/asound/pcm`、声卡 ID 及 `/sys/class/video4linux` 元数据，不通过打开设备来探测；
保留未枚举到的已选标识；网页音视频设备仅提供下拉选择，串口仍允许手动输入。列表中的 available 表示系统枚举存在，不保证可成功采集
或播放。音量只写已支持的硬件混音器；无法驱动所选 PCM 的混音器时保存配置并明确提示。

这些接口返回的是保存值，不是硬件已生效的断言。音频配置与 robotd 启动快照不同则列出 robotd
重启需求；mediad 尚无活动配置查询接口，因此不将未知的活动状态断言为待重启，
只通过提示说明摄像头变更后需要重启 mediad。
页面不自动重启服务。robotd 在 Linux 上检查运行中的 mediad 的 `/proc/*/cmdline`，发现明确的
`--camera-device` 时锁定摄像头节点编辑并说明覆盖值；进程未运行或 `/proc` 不可读时无法观察该覆盖。
mediad 始终优先使用自身明确的命令行节点覆盖。

麦克风选择配置现有的听觉/抚摸检测采集工作线程；它不新增 WebRTC 音频、录音试听或测试音。
