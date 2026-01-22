# Nordic QSPI 驱动 4MB 限制问题分析

## 问题描述

即使正确配置了设备树中的 `size = <0x2000000>` (32MB) 和 `sfdp-bfp` 数据，Nordic QSPI NOR 驱动仍然只识别 4MB，而不是 32MB。

## 根本原因

Nordic QSPI NOR 驱动 (`drivers/flash/nrf_qspi_nor.c`) 可能：
1. **优先使用硬件读取的 SFDP 数据**：驱动在初始化时从硬件芯片读取 SFDP，如果硬件报告的 SFDP 数据显示 4MB，驱动会使用这个值
2. **忽略设备树配置**：即使配置了 `CONFIG_SPI_NOR_SFDP_DEVICETREE=y`，Nordic QSPI 驱动可能有自己的实现，不遵循通用的 SPI NOR SFDP 配置选项
3. **SFDP BFP 数据编码问题**：设备树中的 `sfdp-bfp` 数据可能没有正确编码 32MB 的大小信息

## 已尝试的解决方案

### 1. 配置设备树
- ✅ `size = <0x2000000>` (32MB)
- ✅ `sfdp-bfp` 数据（从硬件读取的正确数据）
- ✅ `address-size-32` (32位地址模式)

### 2. 配置 Kconfig
- ✅ `CONFIG_SPI_NOR_SFDP_DEVICETREE=y`
- ✅ `CONFIG_SPI_NOR_SFDP_RUNTIME=n`

### 3. 配置 nrfutil
- ✅ 自定义 `mx25u256_nrfutil_config.json` (32MB, 32-bit address mode)

**结果**：驱动仍然只识别 4MB

## 可能的解决方案

### 方案 1：修改 Nordic QSPI 驱动源码（推荐）

需要修改 `drivers/flash/nrf_qspi_nor.c`，强制使用设备树中的 `size` 属性：

1. 找到驱动源码位置（通常在 Zephyr SDK 中）：
   ```
   /opt/nordic/ncs/v3.0.0/zephyr/drivers/flash/nrf_qspi_nor.c
   ```

2. 查找读取 flash 大小的代码，修改为优先使用设备树配置：
   ```c
   // 在驱动初始化函数中，强制使用设备树中的 size 属性
   #if DT_NODE_HAS_PROP(DT_NODELABEL(mx25u256), size)
       flash_size = DT_PROP(DT_NODELABEL(mx25u256), size);
   #endif
   ```

3. 或者创建一个补丁文件，在构建时应用

### 方案 2：使用应用层 Workaround

在应用代码中，不依赖 `flash_get_size()` 返回的值，而是：
- 直接使用物理地址（0x0 - 0x2000000）
- 在擦除/写入前手动检查地址范围
- 使用分区管理器 (`pm_static.yml`) 来管理地址空间

**优点**：不需要修改驱动源码
**缺点**：需要手动管理地址范围检查

### 方案 3：联系 Nordic 技术支持

这是一个已知问题或 bug，可能需要：
- 提交 bug 报告给 Nordic/Zephyr
- 等待官方修复
- 获取临时解决方案

## 当前状态

- ✅ 设备树配置正确
- ✅ Kconfig 配置正确
- ✅ nrfutil 配置正确
- ❌ 驱动仍然只识别 4MB
- ✅ 应用层可以使用物理地址直接操作（已验证 `flash erase/write/read` 在 4MB 范围内工作）

## 建议

1. **短期方案**：使用应用层 workaround，直接使用物理地址操作，不依赖驱动报告的 size
2. **长期方案**：修改 Nordic QSPI 驱动源码，或等待官方修复
3. **验证**：测试在 4MB 边界外的地址操作是否真的失败（可能只是 size 报告错误，实际操作可能成功）

## 测试命令

```bash
# 测试 4MB 边界外的操作
flash test_block 400000 131072  # 测试 4MB 地址
flash test_block 500000 131072  # 测试 5MB 地址
flash test_block 1000000 131072 # 测试 16MB 地址
```

如果这些操作成功，说明驱动实际上支持 32MB，只是 `flash_get_size()` 返回的值不正确。
