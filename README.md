# 微信蓝牙控制 SG90 + OLED

适用于普通 ESP32-S3 N16R8 开发板、位置型 SG90 和 SSD1306 128×64 I²C OLED。微信小程序通过 BLE 直接控制，无需 Wi-Fi、服务器或云平台，只能在手机蓝牙覆盖范围内使用。

这是独立 PlatformIO 工程，原有 OLED 文字屏工程不受影响。固件配置为 16 MB Flash、8 MB OPI PSRAM，使用 Arduino-ESP32 3.x 的 LEDC PWM 接口。

## 1. 接线

先断电，按模块上印刷的引脚名称接线。GPIO 编号不是排针序号。

| 部件 | 引脚 / 常见线色 | 连接 |
| --- | --- | --- |
| OLED | VCC | ESP32 3V3 |
| OLED | GND | ESP32 GND |
| OLED | SDA | **GPIO8** |
| OLED | SCL / SCK | **GPIO9** |
| SG90 | 信号，橙色 / 黄色 | **GPIO4** |
| SG90 | 电源正，红色 | **独立稳压 5V 电源正极** |
| SG90 | 电源负，棕色 / 黑色 | 独立电源负极 |
| ESP32 | GND | **独立电源负极，与舵机共地** |

```text
电脑 USB ───────── ESP32-S3
                    ├─ 3V3 ─── OLED VCC
                    ├─ GND ─── OLED GND
                    ├─ GPIO8 ─ OLED SDA
                    ├─ GPIO9 ─ OLED SCL
                    ├─ GPIO4 ─ SG90 信号线
                    └─ GND ───────────────┐
独立 5V 电源负极 ────── SG90 棕/黑线 ──────┘
独立 5V 电源正极 ────── SG90 红线
```

**舵机不接开发板 3V3，也不用 GPIO 给它供电。** 单个 SG90 可用稳压 5V / 2A 电源预留启动电流，开发板继续用 USB 供电；按上述接法只连接两边的 GND，独立电源正极只给舵机供电。TowerPro 官方资料要求外部电源，并注明其 SG90 的工作电流可能达到 0.5–2A，具体以你的舵机资料为准。

OLED 用 3.3V 供电，避免 I²C 上拉至 5V。舵机抖动、板子重启时，先检查电源、共地和接线；在舵机电源附近可并联 470–1000μF 电解电容（耐压至少 6.3V，注意正负极）。固件 GPIO4 输出 3.3V PWM；若具体舵机的信号门限不兼容，需要合适的电平转换。

## 2. 编译、烧录

VS Code / PlatformIO 打开本目录，选 `esp32-s3-n16r8`，点击 Build，再 Upload。也可在 PlatformIO 终端运行：

```sh
pio run
pio device list
pio run --target upload --upload-port COM你的串口号
pio device monitor --baud 115200 --port COM你的串口号
```

构建开始处的通用板型名称可能仍显示 N8 / 8MB / No PSRAM，这是基板描述；本工程已覆盖为 16MB Flash 和 OPI PSRAM，最终镜像头也应为 16MB。实际硬件容量以启动串口输出为准。

本机如果 `pio` 不在 PATH，可使用 PlatformIO 扩展终端，或执行已安装的 `platformio.exe`。串口监视器对应原生 USB CDC；用 USB-UART 接口上传也可以，但启动日志从芯片原生 USB CDC 输出。上传会替换板上原固件。

首次上传连接不上时，按住 BOOT，点按 RST / EN，再松开 BOOT，重新选择串口上传。

启动串口输出蓝牙名 `S3-SERVO-XXXX`、OLED 地址、GPIO、脉宽范围、Flash 和 PSRAM 大小。OLED 自动探测 `0x3C` / `0x3D`，显示蓝牙连接状态、目标逻辑角度、当前输出指令、PWM 脉宽和释放 / 保持状态。OLED 未检测到时仍可控制舵机，小程序会提示屏幕未就绪。屏幕只在启动时检测，修好接线后复位。

## 3. 微信小程序

1. 微信开发者工具导入本目录下的 `miniprogram/`，使用你自己的小程序 AppID。`touristappid` 仅是源码占位，蓝牙需手机真机测试。
2. 在小程序后台按实际情况配置蓝牙用途及用户隐私保护指引。页面使用微信原生隐私同意事件。
3. 使用有开发权限的微信账号手机预览，打开蓝牙，点“搜索开发板”，连接 `S3-SERVO-XXXX`。无需先到手机系统设置中配对。
4. 舵机先空载测试，点“回中 90°”，再试 45° 和 135°。拖动滑块松手时发送指令；按钮在写入和固件确认期间禁用，界面显示开发板回传的状态。
5. 点“释放舵机”停止 PWM。再次选择角度即可恢复输出。蓝牙协议栈报告断线后也会停止 PWM；重连和重新打开页面只读取状态，不自动发送角度。

安卓手机可能需要微信的附近设备权限、定位权限或定位服务，以手机系统提示为准。开发者工具模拟器只能检查页面，不能代替手机连接硬件。

如需保持源码中的 AppID 占位，可生成 Git 忽略的本地副本：

```sh
python tools/prepare_wechat.py --appid 你的小程序AppID
```

然后导入 `.local/wechat/`。源码修改后重新生成副本；此脚本不会修改公开的 `miniprogram/project.config.json`。

## 4. 角度与脉宽

**SG90 的三根线不提供位置反馈。** OLED 的“指令”和小程序的输出角度均来自固件的控制指令，不能证明舵机已到达目标，也不能检测卡住、断电、断线或手动转动。

- 上电不输出 PWM；初始逻辑记录为 90°，不代表轴的真实位置。
- 首次发送角度时从上次记录的指令开始输出，首次为 1500μs；之后每 20ms 最多变化 2 个逻辑角度。重新启用时轴可能不在记录的位置。
- 50Hz PWM，默认 `1000–2000μs` 对应界面的 `0–180°` **逻辑刻度**，90° 对应 1500μs。实际转角和转向取决于舵机型号与校准，不能保证物理 180°。常见 SG90 也有行程不同的版本。
- 如需改变标定，在 `platformio.ini` 修改 `SERVO_MIN_US` / `SERVO_MAX_US`，重新编译烧录。先查具体舵机资料，再从中点小范围测试；不要直接套用 500–2500μs 全行程。
- “释放”只停止信号，不切断舵机电源，不承诺机械制动或所有型号都会完全失去保持力。断线检测也需要 BLE 协议栈超时，不能作为即时停止信号。
- 角度不写入 Flash；断电后恢复初始状态。屏幕状态表示固件执行显示调用，不能检测运行中屏幕被拔掉。

如果手上是连续旋转版 SG90，本项目的角度位置模式不适用；该类舵机的脉宽控制方向和转速。

## 5. BLE 协议

| 项目 | UUID | 属性 |
| --- | --- | --- |
| Service | `e75a0001-4e42-4ea0-9b38-33c7bc713100` | 服务 |
| Command | `e75a0002-4e42-4ea0-9b38-33c7bc713100` | Write |
| Status | `e75a0003-4e42-4ea0-9b38-33c7bc713100` | Read + Notify |

命令固定 6 字节：`A5 01 seq op angleLE16`。seq 为 1–255 循环，op=1 设置 0–180 逻辑角度并开启 PWM，op=2 停止 PWM（angle 必须为 0）。

状态 / ACK 固定 18 字节，均小于默认 BLE 20 字节有效载荷，不依赖调整 MTU：

```text
5A 01 seq op result flags targetLE16 outputLE16 pulseLE16
minAngle8 maxAngle8 minPulseLE16 maxPulseLE16
```

flags：bit0=启动时检测到 OLED，bit1=正在输出 PWM，bit2=输出指令正在渐变。result：0 成功，1 格式错误，2 角度错误，3 PWM 不可用。

命令 ACK 带相同 seq 和 op，表示固件接受命令，不表示机械到位。状态通知和 Read 使用 seq=0 / op=0；指令渐变时状态通知按 150ms 限流，最终停止状态立即推送；已连接时保留每 5 秒一次的低频心跳，用于校正漏收的状态，空闲通知比原先每秒一次减少 80%，断线时不发心跳。手机开启 Notify 后读取初始状态，通过特征值变化事件取得读取结果。每次写入和 ACK 都完成后才发送下一条，二者共同受 3.5 秒超时约束。断线使旧会话的排队命令失效，API 队列最多保留 8 个操作，重复刷新合并为一次读取。无有效包头、长度、版本、序号或操作码的数据会被丢弃，不返回无法关联的 ACK。

蓝牙未设置绑定或访问口令，附近的兼容客户端可以连接和控制。用于多人环境时，可在后续版本添加访问认证。

## 6. 性能与并发处理

- OLED 在 Core 0 的独立低优先级任务中运行，通过单元素覆盖队列接收完整快照，最多约 4 次/秒，只显示最新状态。控制循环不再执行 I²C；屏幕传输或 I²C 超时不再直接拖住舵机指令更新。增加约 6KB 任务栈，内含 1KB 上一帧缓存。
- 首次全屏刷新，之后比较 8×8 像素 tile，只传输发生变化的横向范围。未变化的帧不发送 I²C 数据；单个 tile 变化时，帧缓冲数据为 8 字节，原先为 1024 字节，实际总线通信还包括地址和控制命令。
- 主循环按下一次 20ms 渐变期限等待命令队列，空闲轮询由约 500 次/秒降至约 50 次/秒。LEDC 硬件持续生成 50Hz PWM。连续更新目标不会反复推迟正在进行的渐变。
- 连接状态和连接代次合并为一个原子值；队列等待后重新核验，快速断线重连也不会执行旧会话的排队指令。控制路径取消逐条串口打印，并使用非阻塞 USB 日志，避免电脑未读取串口时卡住。
- 蓝牙操作结束即移除取消监听，避免长时间连接后积累已完成请求；ACK 提前到达也不会关闭系统回调的超时保护，旧回调不能取消新请求。
- 小程序只通过 `setData` 提交变化字段；拖动角度预览按 40ms 合并，仍在松手时发送一次。后台缓存最新遥测，回到前台合并更新；连接和指令 Promise 的旧结果不再覆盖较新的通知。

页面测试中的确定性模拟结果如下；负载为 `setData` 参数的 UTF-8 JSON 字节数，不是真机帧率或系统总耗电测量：

| 模拟输入 | 优化前 setData 次数 / 字节 | 优化后次数 / 字节 |
| --- | --- | --- |
| 与现有状态相同的通知 1000 次 | 1000 / 155000 | 0 / 0 |
| 每 5ms 一次拖动，共 200 次，每 4 次变化 1° | 200 / 5160 | 25 / 295 |
| 后台接收 1000 次变化状态 | 1000 / 155345 | 0 / 0 |
| 上述后台状态返回前台 | — | 1 / 24 |

OLED 的 1024 字节帧在 400kHz 下，仅按每字节 9 个时钟计算就约需 23ms，尚未计入命令和地址开销。这是分离显示任务的依据；实际 PWM 更新抖动、屏幕耗时与手机流畅度仍需真机测量。OLED 可用标志仍是启动检测结果，运行中拔掉屏幕不能实时上报。

## 7. 验证

```sh
npm test
pio run
```

自动测试检查数据边界、BLE 写入 / ACK 时序、断线和页面状态；固件编译检查当前依赖与 N16R8 配置。实际硬件联调仍需在手机和你的开发板上完成。

两个 C++ 测试文件直接包含固件使用的头文件，通过编译期断言检查非法数据帧、脉宽映射、全部 181×181 组角度渐变、连接代次、计时回绕与 OLED 变化 tile 范围。PlatformIO 安装上述环境后，可在工程根目录用 PowerShell 执行（成功时无输出）：

```powershell
& "$env:USERPROFILE\.platformio\packages\toolchain-xtensa-esp-elf\bin\xtensa-esp32s3-elf-g++.exe" -std=c++17 -Wall -Wextra -Werror -fsyntax-only -I include tests/servo_protocol_test.cpp tests/servo_runtime_test.cpp
```

微信模板检查还可设置 `WXML_COMPILER` 环境变量，指向微信开发者工具自带的 `wcc.exe`，再运行 `npm test`；未设置时模板渲染测试会明确跳过。

真机验收顺序：

1. 上电，OLED 显示等待连接、PWM=0，舵机没有收到位置指令。
2. 手机连接后仍不输出 PWM；点回中，检查 1500μs 和回传确认。
3. 发送 45° / 135°，检查 OLED 和手机目标相同、输出指令逐步变化；实际行程依校准判断。
4. 释放后 PWM=0；再次回中恢复输出。
5. 移动途中断开，确认停止 PWM；重新连接只读状态，不恢复旧命令。
6. 断电后临时断开 OLED，再上电，确认小程序提示屏幕未就绪但舵机控制仍可用。

## 参考与许可证

- [Espressif ESP32-S3-DevKitC-1 引脚与 N16R8](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html)
- [Espressif LEDC API：Arduino 3.x，S3 为 1–14 位分辨率](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/ledc.html)
- [TowerPro SG90 官方参数及供电说明](https://towerpro.com.tw/product/sg90-7/)
- [微信 BLE 写入接口](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.writeBLECharacteristicValue.html)
- [微信 BLE Notify 接口](https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth-ble/wx.notifyBLECharacteristicValueChange.html)

蓝牙连接及隐私交互复用本地 `esp32-s3-ble-oled` / MIT 项目 [esp32-s3-ble-rgb](https://github.com/ghtaoge/esp32-s3-ble-rgb) 的代码，保留 LICENSE。U8g2 及字库的许可证见对应依赖。
