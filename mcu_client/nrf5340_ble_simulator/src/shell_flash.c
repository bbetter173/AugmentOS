/*
 * Shell Flash Control Module
 * 
 * External flash operation commands for nRF5340 BLE Simulator
 * Direct flash read/write/erase operations on external QSPI flash
 * 
 * Available Commands:
 * - flash read <address_hex> <size> - Read external flash
 * - flash write <address_hex> <hex_data> - Write external flash
 * - flash erase <address_hex> <size> - Erase external flash
 * - flash info - Show external flash information
 * - flash test_block <address_hex> [block_size] - Test block read/write
 * - flash sfdp - Read and display SFDP data from hardware
 * 
 * Created: 2025-01-21
 * Author: MentraOS Team
 */

#include <ctype.h>
#include <errno.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/flash.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/shell/shell.h>

LOG_MODULE_REGISTER(shell_flash, LOG_LEVEL_INF);

/* ============================================
 * 直接操作外部 Flash 的命令（任意物理地址）
 * Direct External Flash Operations (Any Physical Address)
 * ============================================ */

/* 实际硬件 Flash 大小（32MB） */
/* Actual hardware flash size (32MB) */
#define ACTUAL_FLASH_SIZE 0x2000000ULL  // 32MB

/* 获取实际 Flash 大小（workaround for Nordic QSPI driver 4MB bug） */
/* Get actual flash size (workaround for Nordic QSPI driver 4MB bug) */
static uint64_t get_actual_flash_size(const struct device* flash_dev)
{
    uint64_t reported_size = 0;
    flash_get_size(flash_dev, &reported_size);
    
    /* 如果驱动报告的大小小于 32MB，使用实际硬件大小 */
    /* If driver reports size less than 32MB, use actual hardware size */
    if (reported_size < ACTUAL_FLASH_SIZE)
    {
        return ACTUAL_FLASH_SIZE;
    }
    return reported_size;
}

/* 获取外部 flash 设备 */
/* Get external flash device */
static const struct device* get_external_flash_device(void)
{
#if DT_NODE_EXISTS(DT_CHOSEN(nordic_pm_ext_flash))
    return DEVICE_DT_GET(DT_CHOSEN(nordic_pm_ext_flash));
#else
    /* 如果没有 chosen 节点，尝试通过节点标签获取 */
    /* If no chosen node, try to get by node label */
    return DEVICE_DT_GET(DT_NODELABEL(mx25u256));
#endif
}

/* Shell command: 读取外部 flash 任意地址 */
/* Shell command: Read external flash at any physical address */
static int cmd_flash_read(const struct shell* shell, size_t argc, char** argv)
{
    const struct device* flash_dev;
    off_t                address;
    size_t               read_size;
    uint8_t*             read_buffer;
    int                  ret;

    if (argc < 3)
    {
        shell_error(shell, "Usage: flash read <address_hex> <size>");
        shell_error(shell, "Example: flash read 100000 256");
        shell_error(shell, "         flash read 0 1024");
        return -EINVAL;
    }

    /* 获取外部 flash 设备 */
    flash_dev = get_external_flash_device();
    if (flash_dev == NULL || !device_is_ready(flash_dev))
    {
        shell_error(shell, "❌ External flash device not available");
        return -ENODEV;
    }

    /* 解析地址和大小 */
    address   = (off_t)strtoul(argv[1], NULL, 16);
    read_size = (size_t)strtoul(argv[2], NULL, 0); /* 支持十进制和十六进制 */

    if (read_size == 0 || read_size > 4096)
    {
        shell_error(shell, "Invalid size: %zu (max: 4096 bytes per read)", read_size);
        return -EINVAL;
    }

    /* 检查 flash 设备大小 */
    /* 注意：Nordic QSPI 驱动可能错误报告 4MB，但实际硬件支持 32MB */
    /* Note: Nordic QSPI driver may incorrectly report 4MB, but hardware actually supports 32MB */
    uint64_t flash_size = get_actual_flash_size(flash_dev);
    
    if ((uint64_t)address >= flash_size)
    {
        shell_error(shell, "Address 0x%lx exceeds flash size 0x%llx (32MB)", (unsigned long)address, flash_size);
        return -EINVAL;
    }

    /* 分配读取缓冲区 */
    read_buffer = k_malloc(read_size);
    if (read_buffer == NULL)
    {
        shell_error(shell, "Failed to allocate read buffer");
        return -ENOMEM;
    }

    shell_print(shell, "Reading external flash...");
    shell_print(shell, "  Physical address: 0x%lx", (unsigned long)address);
    shell_print(shell, "  Size: %zu bytes", read_size);
    shell_print(shell, "");

    /* 读取数据 */
    ret = flash_read(flash_dev, address, read_buffer, read_size);
    if (ret != 0)
    {
        shell_error(shell, "Failed to read flash: %d", ret);
        k_free(read_buffer);
        return ret;
    }

    /* 显示数据（十六进制和 ASCII） */
    shell_print(shell, "Data read from 0x%lx:", (unsigned long)address);
    for (size_t i = 0; i < read_size; i += 16)
    {
        shell_fprintf(shell, SHELL_NORMAL, "  %04zx: ", i);
        /* 十六进制显示 */
        for (size_t j = 0; j < 16 && (i + j) < read_size; j++)
        {
            shell_fprintf(shell, SHELL_NORMAL, "%02x ", read_buffer[i + j]);
        }
        /* ASCII 显示 */
        shell_fprintf(shell, SHELL_NORMAL, " |");
        for (size_t j = 0; j < 16 && (i + j) < read_size; j++)
        {
            uint8_t c = read_buffer[i + j];
            shell_fprintf(shell, SHELL_NORMAL, "%c", (c >= 32 && c < 127) ? c : '.');
        }
        shell_fprintf(shell, SHELL_NORMAL, "|\n");
    }

    k_free(read_buffer);
    return 0;
}

/* Shell command: 写入外部 flash 任意地址 */
/* Shell command: Write external flash at any physical address */
static int cmd_flash_write(const struct shell* shell, size_t argc, char** argv)
{
    const struct device* flash_dev;
    off_t                address;
    uint8_t*             write_buffer;
    size_t               data_len;
    int                  ret;

    if (argc < 3)
    {
        shell_error(shell, "Usage: flash write <address_hex> <hex_data>");
        shell_error(shell, "Example: flash write 100000 48656c6c6f");
        shell_error(shell, "         flash write 0 0102030405060708");
        return -EINVAL;
    }

    /* 获取外部 flash 设备 */
    flash_dev = get_external_flash_device();
    if (flash_dev == NULL || !device_is_ready(flash_dev))
    {
        shell_error(shell, "❌ External flash device not available");
        return -ENODEV;
    }

    /* 解析地址 */
    address = (off_t)strtoul(argv[1], NULL, 16);

    /* 解析十六进制数据 */
    const char* hex_data = argv[2];
    data_len             = strlen(hex_data);
    if (data_len == 0 || data_len % 2 != 0)
    {
        shell_error(shell, "Invalid hex data: length must be even");
        return -EINVAL;
    }
    data_len /= 2; /* 转换为字节数 */

    if (data_len == 0 || data_len > 4096)
    {
        shell_error(shell, "Invalid data size: %zu bytes (max: 4096)", data_len);
        return -EINVAL;
    }

    /* 检查地址对齐（flash 写入通常需要 4 字节对齐） */
    if (address % 4 != 0)
    {
        shell_warn(shell, "⚠️  Address 0x%lx not 4-byte aligned", (unsigned long)address);
    }

    /* 检查 flash 设备大小 */
    uint64_t flash_size = get_actual_flash_size(flash_dev);
    if ((uint64_t)address + data_len > flash_size)
    {
        shell_error(shell, "Write range 0x%lx-0x%lx exceeds flash size 0x%llx (32MB)", (unsigned long)address,
                    (unsigned long)address + data_len, flash_size);
        return -EINVAL;
    }

    /* 分配写入缓冲区 */
    write_buffer = k_malloc(data_len);
    if (write_buffer == NULL)
    {
        shell_error(shell, "Failed to allocate write buffer");
        return -ENOMEM;
    }

    /* 转换十六进制字符串为字节 */
    for (size_t i = 0; i < data_len; i++)
    {
        char hex_byte[3] = {hex_data[i * 2], hex_data[i * 2 + 1], '\0'};
        write_buffer[i]  = (uint8_t)strtoul(hex_byte, NULL, 16);
    }

    shell_print(shell, "Writing to external flash...");
    shell_print(shell, "  Physical address: 0x%lx", (unsigned long)address);
    shell_print(shell, "  Size: %zu bytes", data_len);
    shell_print(shell, "");

    /* 写入数据 */
    ret = flash_write(flash_dev, address, write_buffer, data_len);
    if (ret != 0)
    {
        shell_error(shell, "Failed to write flash: %d", ret);
        k_free(write_buffer);
        return ret;
    }

    shell_print(shell, "✅ Data written successfully");

    /* 验证写入 */
    uint8_t* verify_buffer = k_malloc(data_len);
    if (verify_buffer != NULL)
    {
        ret = flash_read(flash_dev, address, verify_buffer, data_len);
        if (ret == 0)
        {
            bool match = (memcmp(write_buffer, verify_buffer, data_len) == 0);
            if (match)
            {
                shell_print(shell, "✅ Verification passed");
            }
            else
            {
                shell_warn(shell, "⚠️  Verification failed - data mismatch");
            }
        }
        k_free(verify_buffer);
    }

    k_free(write_buffer);
    return 0;
}

/* Shell command: 擦除外部 flash 任意地址 */
/* Shell command: Erase external flash at any physical address */
static int cmd_flash_erase(const struct shell* shell, size_t argc, char** argv)
{
    const struct device* flash_dev;
    off_t                address;
    size_t               erase_size;
    int                  ret;

    if (argc < 3)
    {
        shell_error(shell, "Usage: flash erase <address_hex> <size>");
        shell_error(shell, "Example: flash erase 100000 100000");
        shell_error(shell, "         flash erase 0 1000");
        return -EINVAL;
    }

    /* 获取外部 flash 设备 */
    flash_dev = get_external_flash_device();
    if (flash_dev == NULL || !device_is_ready(flash_dev))
    {
        shell_error(shell, "❌ External flash device not available");
        return -ENODEV;
    }

    /* 解析地址和大小 */
    address    = (off_t)strtoul(argv[1], NULL, 16);
    erase_size = (size_t)strtoul(argv[2], NULL, 0); /* 支持十进制和十六进制 */

    if (erase_size == 0)
    {
        shell_error(shell, "Invalid erase size: %zu", erase_size);
        return -EINVAL;
    }

    /* 检查 flash 设备大小 */
    uint64_t flash_size = get_actual_flash_size(flash_dev);
    if ((uint64_t)address + erase_size > flash_size)
    {
        shell_error(shell, "Erase range 0x%lx-0x%lx exceeds flash size 0x%llx (32MB)", (unsigned long)address,
                    (unsigned long)address + erase_size, flash_size);
        return -EINVAL;
    }

    /* 获取擦除块信息 */
    struct flash_pages_info page_info;
    ret = flash_get_page_info_by_offs(flash_dev, address, &page_info);
    if (ret != 0)
    {
        shell_error(shell, "Failed to get flash page info: %d", ret);
        return ret;
    }

    size_t erase_block_size = page_info.size;
    shell_print(shell, "Erasing external flash...");
    shell_print(shell, "  Physical address: 0x%lx", (unsigned long)address);
    shell_print(shell, "  Size: %zu bytes (%.2f MB)", erase_size, erase_size / 1024.0 / 1024.0);
    shell_print(shell, "  Erase block size: %zu bytes", erase_block_size);

    /* 检查对齐 */
    if (address % erase_block_size != 0)
    {
        shell_warn(shell, "⚠️  Address 0x%lx not aligned to erase block size %zu", (unsigned long)address,
                   erase_block_size);
        shell_warn(shell, "⚠️  Erase may fail or erase more than requested");
    }

    if (erase_size % erase_block_size != 0)
    {
        shell_warn(shell, "⚠️  Size %zu not aligned to erase block size %zu", erase_size, erase_block_size);
        shell_warn(shell, "⚠️  Erase may fail or erase more than requested");
    }

    shell_print(shell, "  This may take a while...");
    shell_print(shell, "");

    /* 执行擦除 */
    ret = flash_erase(flash_dev, address, erase_size);
    if (ret != 0)
    {
        shell_error(shell, "Failed to erase flash: %d", ret);
        if (ret == -EINVAL)
        {
            shell_error(shell, "  ❌ -EINVAL: Check address and size alignment");
        }
        return ret;
    }

    shell_print(shell, "✅ Flash erased successfully");
    return 0;
}

/* Shell command: 显示外部 flash 信息 */
/* Shell command: Show external flash information */
static int cmd_flash_info(const struct shell* shell, size_t argc, char** argv)
{
    const struct device* flash_dev;
    int                  ret;

    /* 获取外部 flash 设备 */
    flash_dev = get_external_flash_device();
    if (flash_dev == NULL || !device_is_ready(flash_dev))
    {
        shell_error(shell, "❌ External flash device not available");
        return -ENODEV;
    }

    shell_print(shell, "External Flash Information");
    shell_print(shell, "==========================");
    shell_print(shell, "Device: %s", flash_dev->name);

    /* 获取 flash 大小 */
    uint64_t flash_size = 0;
    ret                 = flash_get_size(flash_dev, &flash_size);
    if (ret == 0)
    {
        shell_print(shell, "Size: %llu bytes (0x%llx, %.2f MB)", flash_size, flash_size,
                    flash_size / 1024.0 / 1024.0);
        
        /* 诊断信息：检查是否与设备树配置匹配 */
        /* Diagnostic: Check if matches device tree configuration */
        if (flash_size == 0x400000)
        {
            shell_warn(shell, "");
            shell_warn(shell, "⚠️  警告：驱动只识别 4MB，而不是设备树中配置的 32MB");
            shell_warn(shell, "⚠️  Warning: Driver only recognizes 4MB, not 32MB configured in device tree");
            shell_warn(shell, "");
            shell_warn(shell, "可能的原因 / Possible reasons:");
            shell_warn(shell, "  1. Nordic QSPI 驱动优先使用硬件读取的 SFDP 数据");
            shell_warn(shell, "      Nordic QSPI driver prioritizes hardware-read SFDP data");
            shell_warn(shell, "  2. 设备树中的 sfdp-bfp 或 size 属性未被驱动使用");
            shell_warn(shell, "      Device tree sfdp-bfp or size property not used by driver");
            shell_warn(shell, "  3. 硬件芯片报告的 SFDP 数据可能不正确（4MB 而不是 32MB）");
            shell_warn(shell, "      Hardware chip reports incorrect SFDP data (4MB instead of 32MB)");
            shell_warn(shell, "");
            shell_warn(shell, "建议 / Suggestions:");
            shell_warn(shell, "  - 检查 CONFIG_SPI_NOR_SFDP_DEVICETREE=y 是否生效");
            shell_warn(shell, "  - 检查设备树中的 size = <0x2000000> 是否正确");
            shell_warn(shell, "  - 可能需要修改 Nordic QSPI 驱动源码以强制使用设备树配置");
            shell_warn(shell, "");
        }
        else if (flash_size == 0x2000000)
        {
            shell_print(shell, "✅ Flash 大小正确：32MB");
        }
    }
    else
    {
        shell_warn(shell, "Failed to get flash size: %d", ret);
    }

    /* 获取擦除块信息 */
    struct flash_pages_info page_info;
    ret = flash_get_page_info_by_offs(flash_dev, 0, &page_info);
    if (ret == 0)
    {
        shell_print(shell, "Erase block size: %u bytes (0x%x)", page_info.size, page_info.size);
        shell_print(shell, "Page count: %u", page_info.index);
    }
    else
    {
        shell_warn(shell, "Failed to get page info: %d", ret);
    }

    /* 显示分区信息 */
    shell_print(shell, "");
    shell_print(shell, "Partition Layout (from pm_static.yml):");
    shell_print(shell, "  0x000000 - 0x900000 (9MB):   font_storage");
    shell_print(shell, "  0x900000 - 0x2000000 (23MB): external_flash");

    return 0;
}

/* Shell command: 测试外部 flash 块读写 */
/* Shell command: Test external flash block read/write */
static int cmd_flash_test_block(const struct shell* shell, size_t argc, char** argv)
{
    const struct device* flash_dev;
    off_t                test_address;
    size_t               block_size;
    uint8_t*             write_buffer;
    uint8_t*             read_buffer;
    int                  ret;
    bool                 success = true;

    /* 解析参数 */
    if (argc < 2)
    {
        shell_error(shell, "Usage: flash test_block <address_hex> [block_size]");
        shell_error(shell, "Example: flash test_block 0 65536");
        shell_error(shell, "         flash test_block 100000");
        shell_error(shell, "  address_hex: Physical address to test (hex)");
        shell_error(shell, "  block_size: Block size in bytes (default: 64KB = 65536)");
        return -EINVAL;
    }

    test_address = (off_t)strtoul(argv[1], NULL, 16);

    if (argc >= 3)
    {
        block_size = (size_t)strtoul(argv[2], NULL, 0);
    }
    else
    {
        block_size = 64 * 1024; /* 默认 64KB */
    }

    if (block_size == 0 || block_size > 256 * 1024)
    {
        shell_error(shell, "Invalid block size: %zu (max: 256KB)", block_size);
        return -EINVAL;
    }

    shell_print(shell, "==========================================");
    shell_print(shell, "外部 Flash 块读写测试");
    shell_print(shell, "External Flash Block Read/Write Test");
    shell_print(shell, "==========================================");
    shell_print(shell, "测试地址 / Test address: 0x%lx", (unsigned long)test_address);
    shell_print(shell, "块大小 / Block size: %zu bytes (%.2f KB)", block_size, block_size / 1024.0);
    shell_print(shell, "");

    /* 获取外部 flash 设备 */
    flash_dev = get_external_flash_device();
    if (flash_dev == NULL || !device_is_ready(flash_dev))
    {
        shell_error(shell, "❌ External flash device not available");
        return -ENODEV;
    }

    /* 获取擦除块信息 */
    struct flash_pages_info page_info;
    ret = flash_get_page_info_by_offs(flash_dev, test_address, &page_info);
    if (ret != 0)
    {
        shell_error(shell, "Failed to get flash page info: %d", ret);
        return ret;
    }

    size_t erase_block_size = page_info.size;
    shell_print(shell, "Flash 擦除块大小 / Flash erase block size: %u bytes (0x%x)", erase_block_size,
                erase_block_size);

    /* 检查地址对齐 */
    if (test_address % erase_block_size != 0)
    {
        shell_warn(shell, "⚠️  地址未对齐到擦除块大小");
        shell_warn(shell, "⚠️  Address not aligned to erase block size");
        shell_warn(shell, "  将对齐到: 0x%lx", (unsigned long)((test_address / erase_block_size) * erase_block_size));
        test_address = (test_address / erase_block_size) * erase_block_size;
    }

    /* 对齐块大小到擦除块大小的倍数 */
    if (block_size % erase_block_size != 0)
    {
        size_t aligned_block_size = ((block_size + erase_block_size - 1) / erase_block_size) * erase_block_size;
        shell_warn(shell, "⚠️  块大小未对齐，将对齐到: %zu bytes", aligned_block_size);
        block_size = aligned_block_size;
    }

    shell_print(shell, "");
    shell_print(shell, "对齐后的参数 / Aligned parameters:");
    shell_print(shell, "  地址 / Address: 0x%lx", (unsigned long)test_address);
    shell_print(shell, "  块大小 / Block size: %zu bytes", block_size);
    shell_print(shell, "");

    /* 检查 flash 设备大小 */
    uint64_t flash_size = get_actual_flash_size(flash_dev);
    if ((uint64_t)test_address + block_size > flash_size)
    {
        shell_error(shell, "测试范围超出 flash 大小");
        shell_error(shell, "Test range exceeds flash size");
        shell_error(shell, "  地址范围 / Address range: 0x%lx - 0x%lx", (unsigned long)test_address,
                    (unsigned long)test_address + block_size);
        shell_error(shell, "  Flash 大小 / Flash size: 0x%llx (32MB)", flash_size);
        return -EINVAL;
    }

    /* 分配缓冲区 */
    write_buffer = k_malloc(block_size);
    read_buffer  = k_malloc(block_size);
    if (write_buffer == NULL || read_buffer == NULL)
    {
        shell_error(shell, "Failed to allocate buffers");
        if (write_buffer)
            k_free(write_buffer);
        if (read_buffer)
            k_free(read_buffer);
        return -ENOMEM;
    }

    /* 生成测试数据（已知模式） */
    shell_print(shell, "步骤 1: 生成测试数据 / Step 1: Generate test data");
    for (size_t i = 0; i < block_size; i++)
    {
        write_buffer[i] = (uint8_t)(0xAA + (i % 0x56)); /* 模式: AA, AB, AC, ... */
    }
    shell_print(shell, "✅ 生成了 %zu 字节测试数据", block_size);
    shell_print(shell, "✅ Generated %zu bytes test data", block_size);
    shell_print(shell, "");

    /* 步骤 2: 擦除块 */
    shell_print(shell, "步骤 2: 擦除块 / Step 2: Erase block");
    shell_print(shell, "  地址 / Address: 0x%lx", (unsigned long)test_address);
    shell_print(shell, "  大小 / Size: %zu bytes (%.2f KB)", block_size, block_size / 1024.0);
    shell_print(shell, "  这可能需要一些时间...");
    shell_print(shell, "  This may take a while...");

    ret = flash_erase(flash_dev, test_address, block_size);
    if (ret != 0)
    {
        shell_error(shell, "❌ 擦除失败 / Erase failed: %d", ret);
        if (ret == -EINVAL)
        {
            shell_error(shell, "  可能是地址越界或未对齐");
            shell_error(shell, "  Possibly out-of-bounds or misaligned");
        }
        success = false;
        goto cleanup;
    }
    shell_print(shell, "✅ 擦除成功 / Erase successful");
    shell_print(shell, "");

    /* 步骤 3: 写入块 */
    shell_print(shell, "步骤 3: 写入块 / Step 3: Write block");
    shell_print(shell, "  地址 / Address: 0x%lx", (unsigned long)test_address);
    shell_print(shell, "  大小 / Size: %zu bytes", block_size);

    /* Flash 写入需要分块进行（通常最大 256 字节） */
    const size_t write_chunk_size = 256;
    size_t       bytes_written     = 0;

    while (bytes_written < block_size)
    {
        size_t chunk_size = (block_size - bytes_written > write_chunk_size) ? write_chunk_size
                                                                             : (block_size - bytes_written);

        ret = flash_write(flash_dev, test_address + bytes_written, write_buffer + bytes_written, chunk_size);
        if (ret != 0)
        {
            shell_error(shell, "❌ 写入失败 / Write failed at offset %zu: %d", bytes_written, ret);
            success = false;
            goto cleanup;
        }

        bytes_written += chunk_size;

        /* 显示进度 */
        if (bytes_written % (block_size / 10) == 0 || bytes_written == block_size)
        {
            shell_print(shell, "  进度 / Progress: %zu / %zu bytes (%.1f%%)", bytes_written, block_size,
                        100.0 * bytes_written / block_size);
        }
    }
    shell_print(shell, "✅ 写入成功 / Write successful");
    shell_print(shell, "");

    /* 步骤 4: 读取块 */
    shell_print(shell, "步骤 4: 读取块 / Step 4: Read block");
    shell_print(shell, "  地址 / Address: 0x%lx", (unsigned long)test_address);
    shell_print(shell, "  大小 / Size: %zu bytes", block_size);

    ret = flash_read(flash_dev, test_address, read_buffer, block_size);
    if (ret != 0)
    {
        shell_error(shell, "❌ 读取失败 / Read failed: %d", ret);
        success = false;
        goto cleanup;
    }
    shell_print(shell, "✅ 读取成功 / Read successful");
    shell_print(shell, "");

    /* 步骤 5: 验证数据 */
    shell_print(shell, "步骤 5: 验证数据 / Step 5: Verify data");
    bool   data_match     = true;
    size_t first_mismatch = 0;

    for (size_t i = 0; i < block_size; i++)
    {
        if (write_buffer[i] != read_buffer[i])
        {
            if (data_match)
            {
                first_mismatch = i;
            }
            data_match = false;
            /* 只报告前几个不匹配 */
            if (i - first_mismatch < 10)
            {
                shell_error(shell, "  不匹配 / Mismatch at offset %zu: 写入=0x%02x, 读取=0x%02x", i,
                            write_buffer[i], read_buffer[i]);
            }
        }
    }

    if (data_match)
    {
        shell_print(shell, "✅ 数据验证通过！所有 %zu 字节匹配", block_size);
        shell_print(shell, "✅ Data verification passed! All %zu bytes match", block_size);
    }
    else
    {
        shell_error(shell, "❌ 数据验证失败！第一个不匹配位置: %zu", first_mismatch);
        shell_error(shell, "❌ Data verification failed! First mismatch at offset: %zu", first_mismatch);
        success = false;
    }

    /* 显示前 32 字节对比 */
    shell_print(shell, "");
    shell_print(shell, "前 32 字节对比 / First 32 bytes comparison:");
    for (size_t i = 0; i < 32 && i < block_size; i++)
    {
        bool match = (write_buffer[i] == read_buffer[i]);
        shell_print(shell, "  [%zu]: 写入=0x%02x, 读取=0x%02x %s", i, write_buffer[i], read_buffer[i],
                    match ? "✅" : "❌");
    }

cleanup:
    shell_print(shell, "");
    shell_print(shell, "==========================================");
    if (success)
    {
        shell_print(shell, "✅ 块读写测试通过！");
        shell_print(shell, "✅ Block read/write test passed!");
    }
    else
    {
        shell_error(shell, "❌ 块读写测试失败！");
        shell_error(shell, "❌ Block read/write test failed!");
    }
    shell_print(shell, "==========================================");

    k_free(write_buffer);
    k_free(read_buffer);
    return success ? 0 : -1;
}

/* Shell command: 读取并显示 SFDP 数据 */
/* Shell command: Read and display SFDP data */
static int cmd_flash_sfdp(const struct shell* shell, size_t argc, char** argv)
{
    const struct device* flash_dev;
    int                  ret;

    /* 获取外部 flash 设备 */
    flash_dev = get_external_flash_device();
    if (flash_dev == NULL || !device_is_ready(flash_dev))
    {
        shell_error(shell, "❌ External flash device not available");
        return -ENODEV;
    }

    shell_print(shell, "==========================================");
    shell_print(shell, "读取外部 Flash SFDP 数据");
    shell_print(shell, "Reading External Flash SFDP Data");
    shell_print(shell, "==========================================");

    /* 读取完整的 SFDP 数据（256 字节） */
    /* Read complete SFDP data (256 bytes) */
    uint8_t sfdp_data[256];
    ret = flash_sfdp_read(flash_dev, 0, sfdp_data, sizeof(sfdp_data));

    if (ret != 0)
    {
        if (ret == -ENOTSUP)
        {
            shell_error(shell, "❌ SFDP API 不支持");
            shell_error(shell, "   请确认 CONFIG_FLASH_JESD216_API=y 已启用");
            shell_error(shell, "   Please confirm CONFIG_FLASH_JESD216_API=y is enabled");
        }
        else
        {
            shell_error(shell, "❌ SFDP 读取失败: %d", ret);
        }
        return ret;
    }

    shell_print(shell, "✅ SFDP 读取成功");
    shell_print(shell, "");
    shell_print(shell, "完整的 SFDP 数据 (256 字节) / Complete SFDP Data (256 bytes):");
    shell_print(shell, "");

    /* 打印完整的 SFDP 数据（每行 16 字节） */
    /* Print complete SFDP data (16 bytes per line) */
    for (size_t i = 0; i < sizeof(sfdp_data); i += 16)
    {
        shell_print(shell, "%04zx: %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x",
            i,
            sfdp_data[i + 0], sfdp_data[i + 1], sfdp_data[i + 2], sfdp_data[i + 3],
            sfdp_data[i + 4], sfdp_data[i + 5], sfdp_data[i + 6], sfdp_data[i + 7],
            sfdp_data[i + 8], sfdp_data[i + 9], sfdp_data[i + 10], sfdp_data[i + 11],
            sfdp_data[i + 12], sfdp_data[i + 13], sfdp_data[i + 14], sfdp_data[i + 15]);
    }

    shell_print(shell, "");
    shell_print(shell, "==========================================");

    /* 验证 SFDP 签名 */
    /* Verify SFDP signature */
    if (sfdp_data[0] == 0x53 && sfdp_data[1] == 0x46 && 
        sfdp_data[2] == 0x44 && sfdp_data[3] == 0x50)
    {
        shell_print(shell, "✅ SFDP 签名正确: %02x %02x %02x %02x (\"SFDP\")",
            sfdp_data[0], sfdp_data[1], sfdp_data[2], sfdp_data[3]);
    }
    else
    {
        shell_warn(shell, "⚠️  SFDP 签名不匹配: %02x %02x %02x %02x (期望: 53 46 44 50)",
            sfdp_data[0], sfdp_data[1], sfdp_data[2], sfdp_data[3]);
    }

    shell_print(shell, "");
    shell_print(shell, "==========================================");
    shell_print(shell, "提取的 BFP 数据 (偏移 0x30 开始的 64 字节)");
    shell_print(shell, "Extracted BFP Data (64 bytes from offset 0x30)");
    shell_print(shell, "==========================================");
    shell_print(shell, "");
    shell_print(shell, "注意：BFP 表在 SFDP 中的位置可能因芯片而异");
    shell_print(shell, "Note: BFP table position in SFDP may vary by chip");
    shell_print(shell, "对于 MX25U256，BFP 从偏移 0x30 开始（不是 0x08）");
    shell_print(shell, "For MX25U256, BFP starts at offset 0x30 (not 0x08)");
    shell_print(shell, "");
    shell_print(shell, "这些数据可以直接用于设备树的 sfdp-bfp 属性：");
    shell_print(shell, "This data can be directly used in device tree sfdp-bfp property:");
    shell_print(shell, "");

    /* 提取并打印 BFP 数据（偏移 0x30 开始的 64 字节） */
    /* Extract and print BFP data (64 bytes starting from offset 0x30) */
    /* 注意：对于 MX25U256，BFP 表从偏移 0x30 开始，不是 0x08 */
    /* Note: For MX25U256, BFP table starts at offset 0x30, not 0x08 */
    const size_t bfp_offset = 0x30;
    const size_t bfp_size = 64;
    
    for (size_t i = 0; i < bfp_size; i += 16)
    {
        shell_print(shell, "%04zx: %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x",
            bfp_offset + i,
            sfdp_data[bfp_offset + i + 0], sfdp_data[bfp_offset + i + 1], 
            sfdp_data[bfp_offset + i + 2], sfdp_data[bfp_offset + i + 3],
            sfdp_data[bfp_offset + i + 4], sfdp_data[bfp_offset + i + 5], 
            sfdp_data[bfp_offset + i + 6], sfdp_data[bfp_offset + i + 7],
            sfdp_data[bfp_offset + i + 8], sfdp_data[bfp_offset + i + 9], 
            sfdp_data[bfp_offset + i + 10], sfdp_data[bfp_offset + i + 11],
            sfdp_data[bfp_offset + i + 12], sfdp_data[bfp_offset + i + 13], 
            sfdp_data[bfp_offset + i + 14], sfdp_data[bfp_offset + i + 15]);
    }

    shell_print(shell, "");
    shell_print(shell, "设备树格式 / Device tree format:");
    shell_print(shell, "sfdp-bfp = [");
    for (size_t i = 0; i < bfp_size; i += 16)
    {
        shell_print(shell, "    %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x",
            sfdp_data[bfp_offset + i + 0], sfdp_data[bfp_offset + i + 1], 
            sfdp_data[bfp_offset + i + 2], sfdp_data[bfp_offset + i + 3],
            sfdp_data[bfp_offset + i + 4], sfdp_data[bfp_offset + i + 5], 
            sfdp_data[bfp_offset + i + 6], sfdp_data[bfp_offset + i + 7],
            sfdp_data[bfp_offset + i + 8], sfdp_data[bfp_offset + i + 9], 
            sfdp_data[bfp_offset + i + 10], sfdp_data[bfp_offset + i + 11],
            sfdp_data[bfp_offset + i + 12], sfdp_data[bfp_offset + i + 13], 
            sfdp_data[bfp_offset + i + 14], sfdp_data[bfp_offset + i + 15]);
    }
    shell_print(shell, "];");
    shell_print(shell, "");
    shell_print(shell, "==========================================");

    return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(
    sub_flash, SHELL_CMD(read, NULL, "Read external flash: flash read <address_hex> <size>", cmd_flash_read),
    SHELL_CMD(write, NULL, "Write external flash: flash write <address_hex> <hex_data>", cmd_flash_write),
    SHELL_CMD(erase, NULL, "Erase external flash: flash erase <address_hex> <size>", cmd_flash_erase),
    SHELL_CMD(info, NULL, "Show external flash information", cmd_flash_info),
    SHELL_CMD(test_block, NULL, "Test block read/write: flash test_block <address_hex> [block_size]", cmd_flash_test_block),
    SHELL_CMD(sfdp, NULL, "Read and display SFDP data from hardware", cmd_flash_sfdp),
    SHELL_SUBCMD_SET_END);

SHELL_CMD_REGISTER(flash, &sub_flash, "Direct external flash operations (any physical address)", NULL);
