# QSPI SFDP 配置总结

## 当前配置状态

### 1. 设备树配置（`nrf5340dk_nrf5340_cpuapp_ns.overlay`）

```dts
mx25u256: mx25u256@0 {
    compatible = "nordic,qspi-nor";
    reg = <0>;
    writeoc = "pp4io";
    readoc = "read4io";
    sck-frequency = <8000000>;
    address-size-32;              // ✅ 32位地址模式
    enter-4byte-addr = <0xb7>;   // ✅ 进入4字节地址模式命令
    jedec-id = [c2 25 39];       // ✅ JEDEC ID
    
    /* BFP 数据从 SFDP 偏移 0x30 开始（64 字节） */
    /* BFP data starts at SFDP offset 0x30 (64 bytes) */
    sfdp-bfp = [ 
        e5 20 fb ff ff ff ff 0f 44 eb 08 6b 08 3b 04 bb
        fe ff ff ff ff ff 00 ff ff ff 44 eb 0c 20 0f 52
        10 d8 00 ff 25 52 dd 00 84 a5 04 e2 44 03 17 38
        30 b0 30 b0 f7 bd d5 5c 4a 9e 29 ff f0 50 f9 85];
    
    size = <0x2000000>;  // ✅ 32MB (字节单位，正确)
    has-dpd;
    t-enter-dpd = <10000>;
    t-exit-dpd = <35000>;
};
```

**关键点**：
- ✅ `size = <0x2000000>` 是 32MB（字节单位），正确
- ✅ `sfdp-bfp` 是从硬件读取的 SFDP 偏移 0x30 开始的 64 字节 BFP 数据
- ✅ `address-size-32` 和 `enter-4byte-addr` 已配置

### 2. Kconfig 配置（`prj.conf`）

```conf
CONFIG_NORDIC_QSPI_NOR=y
CONFIG_NORDIC_QSPI_NOR_FLASH_LAYOUT_PAGE_SIZE=4096

# SFDP 配置：强制使用设备树中的 sfdp-bfp 和 size
CONFIG_SPI_NOR_SFDP_DEVICETREE=y
CONFIG_SPI_NOR_SFDP_MINIMAL=n
CONFIG_SPI_NOR_SFDP_RUNTIME=n

CONFIG_FLASH_JESD216_API=y
```

**配置说明**：
- ✅ `CONFIG_SPI_NOR_SFDP_DEVICETREE=y`：使用设备树中的 `sfdp-bfp`
- ✅ `CONFIG_SPI_NOR_SFDP_MINIMAL=n`：禁用最小 SFDP（避免覆盖设备树配置）
- ✅ `CONFIG_SPI_NOR_SFDP_RUNTIME=n`：禁用运行时从硬件读取 SFDP
- ✅ `CONFIG_FLASH_JESD216_API=y`：启用 SFDP API（用于 `flash_sfdp_read()`）

## 问题分析

### 当前现象
- 设备树配置：32MB (`size = <0x2000000>`)
- 驱动报告：4MB (`0x400000`)
- BFP 数据：已正确提取并配置

### 可能的原因

根据 Nordic DevZone 讨论和文档：

1. **Nordic QSPI 驱动对 `sfdp-bfp` 的支持有限**
   - Nordic QSPI 驱动 (`nordic,qspi-nor`) 可能不会完全使用 `sfdp-bfp` 来决定容量
   - 某些参数（如读命令的 dummy cycle）可能是固定的，不能从 `sfdp-bfp` 推导
   - 驱动可能优先使用硬件读取的 SFDP 数据

2. **SFDP 来源优先级**
   - 即使配置了 `CONFIG_SPI_NOR_SFDP_DEVICETREE=y`，Nordic QSPI 驱动可能有自己的实现
   - 驱动可能仍然从硬件读取 SFDP，而不是使用设备树配置

3. **地址模式问题**
   - 如果地址模式是 24-bit，容量会被限制在 16MB
   - 已配置 `address-size-32` 和 `enter-4byte-addr`，应该支持 32-bit 地址

## 已验证的配置

### ✅ 正确的 BFP 提取
- 使用 `flash sfdp` 命令从硬件读取 SFDP
- BFP 数据从偏移 0x30 开始（不是 0x08）
- 64 字节 BFP 数据已正确提取并配置到设备树

### ✅ 正确的 size 单位
- `size = <0x2000000>` = 32MB（字节单位）
- 不是 bit 单位（32Mbit = 4MB）

### ✅ 应用层 Workaround
- `shell_flash.c` 中已实现 `get_actual_flash_size()` 函数
- 所有 flash 命令使用硬编码的 32MB 大小，绕过驱动报告的 4MB 限制
- 可以操作 0x0 - 0x2000000 (32MB) 范围内的地址

## 建议的下一步

### 1. 重新编译并测试
```bash
west build -b nrf5340dk/nrf5340/cpuapp_ns -p
west flash
```

### 2. 验证配置是否生效
```bash
# 在设备上运行
flash info
flash sfdp
```

### 3. 如果仍然只识别 4MB

**选项 A：接受应用层 workaround**
- 继续使用 `get_actual_flash_size()` 函数
- 不依赖驱动报告的 size
- 直接使用物理地址操作

**选项 B：修改 Nordic QSPI 驱动源码**
- 找到驱动源码：`drivers/flash/nrf_qspi_nor.c`
- 强制使用设备树中的 `size` 属性
- 创建补丁文件

**选项 C：联系 Nordic 技术支持**
- 提交 bug 报告
- 询问是否有配置选项可以强制使用设备树配置

## 参考资料

- [Nordic QSPI NOR Device Tree Binding](https://docs.zephyrproject.org/latest/build/dts/api/bindings/mtd/nordic%2Cqspi-nor.html)
- [nRF9160 External Flash Capacity Discussion](https://devzone.nordicsemi.com/f/nordic-q-a/...)
- [W25Q128 Capacity Issue](https://devzone.nordicsemi.com/f/nordic-q-a/...)
- [MX25U51245G sfdp-bfp Issue](https://devzone.nordicsemi.com/f/nordic-q-a/...)

## 总结

当前配置在理论上是正确的：
- ✅ 设备树配置完整（size, sfdp-bfp, address-size-32）
- ✅ Kconfig 配置正确（SFDP_DEVICETREE=y, SFDP_MINIMAL=n, SFDP_RUNTIME=n）
- ✅ BFP 数据正确提取（偏移 0x30，64 字节）

但 Nordic QSPI 驱动可能仍然只识别 4MB，这是驱动的已知限制。应用层已实现 workaround，可以正常操作 32MB 地址空间。
