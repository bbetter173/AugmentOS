/*
 * @Author       : Cole
 * @Date         : 2025-07-28 11:31:02
 * @LastEditTime : 2025-10-14 16:27:09
 * @FilePath     : a6n.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "a6n.h"

#include <stdio.h>
#include <zephyr/device.h>
#include <zephyr/drivers/display.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/pm/device.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/types.h>

#define LOG_MODULE_NAME CUSTOM_A6N
LOG_MODULE_REGISTER(LOG_MODULE_NAME);

#define SCREEN_WIDTH  640
#define SCREEN_HEIGHT 480
#define DT_DRV_COMPAT zephyr_custom_a6n

#if DT_NUM_INST_STATUS_OKAY(DT_DRV_COMPAT) == 0
#warning "Custom a6n driver enabled without any devices"
#endif
const struct device *dev_a6n = DEVICE_DT_GET(DT_INST(0, DT_DRV_COMPAT));
static K_SEM_DEFINE(a6n_init_sem, 0, 1);

/**
 * A6N 显示配置参数 | A6N Display Configuration
 * ====================================================================
 * 分辨率 | Resolution: 640×480
 * 显示模式 | Display mode: GRAY16 (4-bit)
 * SPI 时钟 | SPI clock: 32MHz
 * 自刷新帧率 | Self-refresh rate: 90Hz
 * 
 * 数据量计算 | Data size calculation:
 *   - 每行字节数 | Bytes per row: 640÷2 = 320 字节 | 320 bytes
 *   - 全屏字节数 | Full frame: 640×480÷2 = 153,600 字节 | 153,600 bytes
 *   - 每批次行数 | Lines per batch: 192 行 | 192 rows
 *   - 每批次字节数 | Bytes per batch: 192×320 = 61,440 字节 | 61,440 bytes
 *   - 批次数量 | Number of batches: 480÷192 = 2.5 批次 | 2.5 batches
 * 
 * ⚠️ 约束验证 | Constraint validation:
 *   ✅ 每批次是行的整数倍 (192行) | Each batch is row-aligned (192 rows)
 *   ✅ 每批次字节数是每行字节数的整数倍 (192×320) | Bytes per batch is multiple of bytes-per-row
 *   ✅ SPI时钟32MHz ≤ 90Hz帧率要求(≤32MHz) | SPI 32MHz meets 90Hz requirement (≤32MHz)
 * ====================================================================
 */
#define MAX_LINES_PER_WRITE 192  // 每次写入的最大行数 | Maximum rows per write batch
void a6n_init_sem_give(void)
{
    k_sem_give(&a6n_init_sem);
}

int a6n_init_sem_take(void)
{
    return k_sem_take(&a6n_init_sem, K_FOREVER);
}
static int write_reg_side(const struct device *dev, const struct gpio_dt_spec *cs, uint8_t reg, uint8_t val)
{
    if ((!device_is_ready(dev)))
    {
        LOG_ERR("device_is_ready err!!!");
        return -EINVAL;
    }
    if (!gpio_is_ready_dt(cs))
    {
        LOG_ERR("gpio_is_ready_dt err!!!");
        return -EINVAL;
    }

    const a6n_config *cfg = dev->config;
    uint8_t  tx[3];
    tx[0] = A6N_LCD_WRITE_ADDRESS;
    tx[1] = reg;
    tx[2] = val;
    const struct spi_buf buf = {
        .buf = tx,
        .len = sizeof(tx),
    };
    const struct spi_buf_set tx_set = {
        .buffers = &buf,
        .count   = 1,
    };
    gpio_pin_set_dt(cs, 0);
    int err = spi_write_dt(&cfg->spi, &tx_set);
    gpio_pin_set_dt(cs, 1);

    if (err)
    {
        LOG_ERR("SPI write_reg_side @0x%02x failed: %d", reg, err);
    }
    return err;
}
/**
 * @brief 设置左右光机的水平/垂直平移与水平镜像
 *        Configure horizontal/vertical shift and horizontal mirror for both left and right A6N optical engines.
 *
 * 寄存器映射 (Register Mapping, per A6N-G-SPI Spec V0.4):
 * ------------------------------------------------------------
 *  Address 0xEF : HD Register (Horizontal Direction) [默认值:0x48]
 *      bit7     = 水平镜像控制位 (Horizontal Mirror Enable, 1=Mirror)
 *      bit[6:5] = 保留为2 (Keep 2, 必须设置为0x40)
 *      bit[4:0] = 水平平移量 (Horizontal Shift, 0~16, 8=居中)
 *
 *  Address 0xF0 : VD Register (Vertical Direction) [默认值:0x08]
 *      bit[7:5] = 保留为0 (Keep 0)
 *      bit[4:0] = 垂直平移量 (Vertical Shift, 0~16, 8=居中)
 * ------------------------------------------------------------
 *
 * 双光机系统说明 (Dual Engine Notes):
 *  - 左右光机共用同一组参数 (Common parameters for both engines)
 *  - 实际写入时根据镜像逻辑自动对称 (Left/Right values auto-inverted for mirrored layout)
 *  - 通过独立片选信号 (left_cs / right_cs) 同时写入两个光机
 *
 * @param h_shift  水平平移量 (0~16)
 *                 Horizontal shift (0~16). Higher value shifts image to the right.
 *
 * @param v_shift  垂直平移量 (0~16)
 *                 Vertical shift (0~16). Higher value shifts image downward.
 *
 * @param mirror   镜像模式
 *                 Mirror mode:
 *                   - A6N_MIRROR_NORMAL : 正常显示 (Normal)
 *                   - A6N_MIRROR_H_FLIP : 水平镜像 (Left-Right Flip)
 *
 * @return 0 表示成功，负数表示 SPI 写入错误。
 *         0 if successful, negative errno on SPI communication error.
 */
int a6n_set_shift_mirror(uint8_t h_shift, uint8_t v_shift, a6n_mirror_mode_t mirror)
{
    const a6n_config *cfg = dev_a6n->config;

    // 参数范围限制 (Range protection)
    if (h_shift > 16) h_shift = 8;
    if (v_shift > 16) v_shift = 8;

    // 0xEF 寄存器: bit7=镜像, bit[6:5]=保持为2(0x40), bit[4:0]=平移 | 0xEF register: bit7=mirror, bit[6:5]=keep 2(0x40), bit[4:0]=shift
    // 左右光机使用相同的镜像设置 | Left/Right engines use same mirror setting
    uint8_t val_l_h = ((mirror == A6N_MIRROR_H_FLIP) ? 0x80 : 0x00) | 0x40 | (h_shift & 0x1F);
    uint8_t val_r_h = ((mirror == A6N_MIRROR_H_FLIP) ? 0x80 : 0x00) | 0x40 | (h_shift & 0x1F);

    // 0xF0 寄存器: bit[7:5]=保持为0, bit[4:0]=垂直平移 | 0xF0 register: bit[7:5]=keep 0, bit[4:0]=v_shift
    uint8_t val_l_v = v_shift & 0x1F;
    uint8_t val_r_v = v_shift & 0x1F;

    int err1 = write_reg_side(dev_a6n, &cfg->left_cs,  A6N_LCD_HD_REG, val_l_h);
    int err2 = write_reg_side(dev_a6n, &cfg->right_cs, A6N_LCD_HD_REG, val_r_h);
    int err3 = write_reg_side(dev_a6n, &cfg->left_cs,  A6N_LCD_VD_REG, val_l_v);
    int err4 = write_reg_side(dev_a6n, &cfg->right_cs, A6N_LCD_VD_REG, val_r_v);

    LOG_INF("A6N_set_shift_mirror: H=%d, V=%d, mirror=%d → "
            "HD[L=0x%02X,R=0x%02X], VD[L=0x%02X,R=0x%02X]",
            h_shift, v_shift, mirror,
            val_l_h, val_r_h, val_l_v, val_r_v);

    return (err1 || err2 || err3 || err4) ? -EIO : 0;
}


/**
 * send all data via SPI with retries
 * @param dev    Device handle
 * @param data   Pointer to data buffer
 * @param size   Size of data buffer in bytes
 * @param retries Number of retries on failure
 * @return 0 on success, negative error code on failure
 */
static int a6n_transmit_all(const struct device *dev, const uint8_t *data, size_t size, int retries)
{
    /* 边界条件检查; Boundary condition check */
    if (!dev || !data || size == 0)
    {
        return -EINVAL;
    }

    int err = -1;
    const a6n_config *cfg = dev->config;
    struct spi_buf tx_buf = {
        .buf = data,
        .len = size,
    };
    struct spi_buf_set tx = {
        .buffers = &tx_buf,
        .count   = 1,
    };

    /* 执行SPI传输（带重试机制）; Execute SPI transmission (with retry mechanism) */
    for (int i = 0; i <= retries; i++)
    {
        // 同时拉低左右 CS | Pull both CS low simultaneously
        gpio_pin_set_dt(&cfg->left_cs, 0);   // Select left CS (active LOW)
        gpio_pin_set_dt(&cfg->right_cs, 0);  // Select right CS (active LOW)
        
        // ✅ FIX: 添加 CS setup time 延时，确保左右光机同步
        // CS setup time delay to ensure left/right engines are synchronized
        k_busy_wait(1);
        
        // SPI 数据传输 | SPI data transfer
        err = spi_write_dt(&cfg->spi, &tx);
        
        // ✅ FIX: 添加 CS hold time 延时，确保数据传输完成
        // CS hold time delay to ensure data transfer completion
        k_busy_wait(1);
        
        // 同时拉高左右 CS | Pull both CS high simultaneously
        gpio_pin_set_dt(&cfg->left_cs, 1);   // Deselect left CS (inactive HIGH)
        gpio_pin_set_dt(&cfg->right_cs, 1);  // Deselect right CS (inactive HIGH)
        
        if (err != 0)
        {
            k_msleep(1); /* 短暂延迟; Short delay */
            LOG_INF("SPI write to left failed (attempt %d/%d): %d", i + 1, retries + 1, err);
            continue;
        }
        else
        {
            return 0; /* 成功; Success */
        }
    }
    return err;
}
/**
 * @brief Switch video format to GRAY16 (4-bit per pixel) via Bank0 register 0xBE.
 *        Bus stays 1-line SPI; only pixel depth becomes 4-bit (2 pixels per byte).
 *
 * Datasheet: Bank0 0xBE: 0x82=GRAY256, 0x84=GRAY16.
 */
int a6n_set_gray16_mode(void)
{
    /* Bank0 0xBE = 0x84 (GRAY16) */
    int ret = a6n_write_reg(0, 0xBE, 0x84);
    if (ret == 0)
    {
        LOG_INF("A6N video format -> GRAY16 (4-bit/pixel) set OK");
    }
    else
    {
        LOG_ERR("Set GRAY16 failed, ret=%d", ret);
    }
    return ret;
}

/**
 * @Description: Command for local data mode
 * @start_line: Starting line number
 * @end_line: Ending line number
 */
void a6n_write_multiple_rows_cmd(const struct device *dev, uint16_t start_line, uint16_t end_line)
{
    uint8_t reg[8] = {0};
    reg[0]         = A6N_LCD_DATA_REG;
    reg[1]         = (A6N_LCD_LOCALITY_REG >> 16) & 0xff;
    reg[2]         = (A6N_LCD_LOCALITY_REG >> 8) & 0xff;
    reg[3]         = A6N_LCD_LOCALITY_REG & 0xff;
    reg[4]         = (start_line >> 8) & 0xff;
    reg[5]         = start_line & 0xff;
    reg[6]         = (end_line >> 8) & 0xff;
    reg[7]         = end_line & 0xff;
    a6n_transmit_all(dev, reg, sizeof(reg), 1);
}

static int a6n_blanking_on(struct device *dev)
{
    return 0;
}

static int a6n_blanking_off(struct device *dev)
{
    return 0;
}
#if 1

/* ================== I1→I4 查表（一次性构建） ================== */ 
// LUT for I1→I4 (one-time construction)
static uint32_t s_i1_to_i4_LUT[256];
static bool     s_i1_to_i4_LUT_built = false;

/* 构建 LUT：输入 1 字节（8 像素，MSB→LSB），输出 4 字节（8 个 4bit 像素：两像素/字节） */
// Build LUT: input 1 byte (8 pixels, MSB→LSB), output 4 bytes (8 4bit pixels: two pixels/byte)
static void a6m_build_i1_to_i4_lut(void)
{
    for (int b = 0; b < 256; b++) 
    {
        /* 逐位展开成 4bit 灰度（0x0 或 0xF） */
        // Expand bit by bit into 4bit grayscale (0x0 or 0xF)
        uint8_t px[8];
        for (int i = 0; i < 8; i++) 
        {
            uint8_t bit = (uint8_t)((b >> (7 - i)) & 0x01);
            uint8_t nib = bit ? 0x00 : 0x0F;  /* 位=0亮（默认） 位=1暗 ; bit=0 bright (default) bit=1 dark */
            px[i] = nib;
        }
        /* 打包成 4 个字节（高4位=左像素，低4位=右像素） */
        // Pack into 4 bytes (high 4 bits = left pixel, low 4 bits = right pixel)
        uint32_t pack =
            ((uint32_t)((px[0] << 4) | px[1]) << 24) |
            ((uint32_t)((px[2] << 4) | px[3]) << 16) |
            ((uint32_t)((px[4] << 4) | px[5]) << 8)  |
            ((uint32_t)((px[6] << 4) | px[7]) << 0);
        s_i1_to_i4_LUT[b] = pack;
    }
    s_i1_to_i4_LUT_built = true;
}
/* ================== 按行转换：I1(1bpp, MSB-first) -> I4(两像素/字节) ================== */
// ================== Line-by-line conversion: I1(1bpp, MSB-first) -> I4(two pixels/byte) ==================
/**
 * @Description: Pack a line of 1bpp pixels into 4bpp using LUT
 * @param src_row  Pointer to source row (1bpp, MSB-first)
 * @param width    Width of the row in pixels
 * @param dst_row  Pointer to destination row (4bpp, two pixels/byte)
 * @return         None
 */
static inline void a6m_pack_i1_to_i4_line_lut(const uint8_t *src_row,
                                              uint16_t width,
                                              uint8_t *dst_row)
{
    /* 每 8 像素（1 字节）→ LUT 输出 4 字节 ; Every 8 pixels (1 byte) → LUT outputs 4 bytes */
    uint16_t full_groups = (uint16_t)(width / 8U);
    uint16_t tail_pixels = (uint16_t)(width % 8U);
    uint16_t out = 0;

    for (uint16_t g = 0; g < full_groups; g++) 
    {
        uint32_t pack = s_i1_to_i4_LUT[src_row[g]];
        dst_row[out + 0] = (uint8_t)(pack >> 24);
        dst_row[out + 1] = (uint8_t)(pack >> 16);
        dst_row[out + 2] = (uint8_t)(pack >> 8);
        dst_row[out + 3] = (uint8_t)(pack >> 0);
        out += 4;
    }

    /* 收尾：不足 8 像素（最多 7），两两拼一个字节 ; Tail: less than 8 pixels (up to 7), two by two spliced into one byte */
    if (tail_pixels) 
    {
        /* 起始 bit 索引（相对这个组的 8bit 块）; Starting bit index (relative to the 8bit block of this group) */
        uint16_t start_bit = (uint16_t)(full_groups * 8U);
        uint8_t  cur_byte  = src_row[full_groups]; /* 安全：调用方保证源行有足够字节 ; Safe: the caller ensures that the source line has enough bytes */

        /* 从 start_bit 开始逐像素取位 */
        // Take bits pixel by pixel starting from start_bit
        uint8_t nib0 = 0, nib1 = 0, have0 = 0;
        for (uint16_t i = 0; i < tail_pixels; i++) 
        {
            /* 计算这个像素在 cur_byte 中的 bit 位置：MSB-first */
            // Calculate the bit position of this pixel in cur_byte: MSB-first
            uint16_t bit_index = (uint16_t)((start_bit + i) % 8U);
            if (bit_index == 0 && i != 0) 
            {
                /* 跨到下一源字节 */
                // Cross to the next source byte
                cur_byte = src_row[full_groups + (i / 8U)];
            }
            uint8_t bit = (cur_byte >> (7 - bit_index)) & 0x01;
            uint8_t nib = bit ? 0x00 : 0x0F;
            if (!have0) 
            {
                nib0 = nib; have0 = 1;
            } 
            else 
            {
                nib1 = nib; have0 = 0;
                dst_row[out++] = (uint8_t)((nib0 << 4) | (nib1 & 0x0F));
            }
        }
        /* 若尾巴是奇数个像素，补最后一个半字节（右像素=0x0）
        If the tail is an odd number of pixels, add the last half byte (right pixel = 0x0) */
        if (have0) 
        {
            dst_row[out++] = (uint8_t)(nib0 << 4);
        }
    }
}

/**
 * @Description: Write pixel data to the display
 * @param dev   Device handle
 * @param x     X coordinate (must be 0)
 * @param y     Y coordinate (starting row)
 * @param desc  Buffer descriptor
 * @param buf   Pointer to pixel data buffer
 * @return      0 on success, negative value on error
 */
static int a6n_write(const struct device *dev, const uint16_t x, const uint16_t y,
                          const struct display_buffer_descriptor *desc, const void *buf)
{
    const a6n_config *cfg    = dev->config;
    a6n_data         *data   = dev->data;
    const uint16_t         width  = desc->width;  
    const uint16_t         height = desc->height;  
    const uint16_t         pitch  = desc->pitch;  /* 源缓冲每行像素（通常=width）; Source buffer pixels per line (usually = width) */

    if (x != 0) 
    {
        LOG_WRN("a6n_write: x must be 0 (x=%u)", x);
        return -ENOTSUP;
    }
    if ((y + height) > cfg->screen_height || width > cfg->screen_width) 
    {
        LOG_WRN("a6n_write: OOB w=%u h=%u y=%u (scr %ux%u)",
                width, height, y, cfg->screen_width, cfg->screen_height);
        return -ENOTSUP;
    }

    /* 首次构建 LUT ; Build LUT for the first time */
    if (!s_i1_to_i4_LUT_built) 
    {
        a6m_build_i1_to_i4_lut();
        LOG_INF("a6n_write: I1->I4 LUT built");
    }

    const uint8_t *src             = (const uint8_t *)buf; /* 1bpp 源 ; 1bpp source */
    const uint16_t src_stride_bytes= (uint16_t)((pitch + 7U) / 8U);
    const uint16_t i4_bytes_per_ln = (uint16_t)((cfg->screen_width + 1U) / 2U); /* 320 */
    uint8_t       *tx              = data->tx_buf_bulk;
    uint8_t       *dst_base        = tx + 4;

    /* 设置行窗口 ; Set row window */
    a6n_write_multiple_rows_cmd(dev, y, (uint16_t)(y + height - 1U));

    /* 写数据前缀（1线 SPI：0x02 + 0x00 0x2C/0x3C 0x00） */
    // write data prefix (1-line SPI: 0x02 + 0x00 0x2C/0x3C 0x00)
    tx[0] = A6N_LCD_DATA_REG;
    tx[1] = (uint8_t)((A6N_LCD_CMD_REG >> 16) & 0xFF);
    tx[2] = (uint8_t)((A6N_LCD_CMD_REG >>  8) & 0xFF);
    tx[3] = (uint8_t)( A6N_LCD_CMD_REG        & 0xFF);

    /* 逐行 LUT 转换 → I4 行（不足 320B 的右侧补 0） */
    // Line-by-line LUT conversion → I4 line (right side of less than 320B is filled with 0)
    for (uint16_t row = 0; row < height; row++) 
    {
        const uint8_t *src_row = src      + (uint32_t)row * src_stride_bytes;
        uint8_t       *dst_row = dst_base + (uint32_t)row * i4_bytes_per_ln;

        /* 先清整行，确保右侧补零 */
        // First clear the entire line to ensure that the right side is filled with zeros
        memset(dst_row, 0x00, i4_bytes_per_ln);

        /* 把本区域 width 像素打包到行左侧（单位：像素），两像素/字节 */
        // Pack the width pixels of this area to the left side of the line (unit: pixel), two pixels/byte
        a6m_pack_i1_to_i4_line_lut(src_row, width, dst_row);
    }

    const uint32_t payload_bytes = (uint32_t)height * (uint32_t)i4_bytes_per_ln;
    const uint32_t bytes_to_send = 4U + payload_bytes;

    int ret = a6n_transmit_all(dev, tx, bytes_to_send, 1);
    #if 0//TEST LOG
    const int64_t t0 = k_uptime_get();
    ret              = a6n_transmit_all(dev, tx, bytes_to_send, 1);
    const int64_t t1 = k_uptime_get();
    const uint32_t ms   = (uint32_t)(t1 - t0);
    const uint32_t kBps = (ms ? (bytes_to_send * 1000U / ms / 1024U) : 0U);
    const uint32_t Mbps = (ms ? (bytes_to_send * 8U / ms / 1000U) : 0U);
    LOG_INF("a6n_write[I1->I4, %uB/line] = [%u]ms, lines[%u], bytes[%u]B, rate≈[%u]KB/s (%uMbit/s)",
            line_bytes_min, ms, height, bytes_to_send, kBps, Mbps);
    #endif

    if (ret)
    {
        LOG_ERR("a6n_write: SPI transmit failed: %d", ret);
        return ret;
    }
    

    return 0;
}
#endif
static int a6n_read(struct device *dev, int x, int y, const struct display_buffer_descriptor *desc, void *buf)
{
    return -ENOTSUP;
}

/**
 * @brief 获取A6N最大亮度值 | Get A6N maximum brightness value
 * 
 * 假设最大亮度为0xFF（根据项目需求可调整）
 * Assume max brightness is 0xFF (adjustable based on project requirements)
 * 
 * @return 最大亮度值 (0xFF) | Max brightness value (0xFF)
 */
int a6n_get_max_brightness(void)
{
    return 0xFF;  // 假设最大亮度为0xFF | Assume max brightness is 0xFF
}

/**
 * @brief 设置A6N显示亮度 | Set A6N display brightness
 * 
 * 根据A6N手册6.4节亮度调节功能说明 | Per A6N manual section 6.4:
 * - 假设最大亮度为0xFF | Assume max brightness is 0xFF
 * - 相邻等级差值最小为2 | Minimum difference between adjacent levels is 2
 * - 最多支持64级亮度可调 | Up to 64 brightness levels supported
 * 
 * @param brightness 亮度值 (0x00-0xFF) | Brightness level (0x00-0xFF)
 * @return 0 表示成功，负数表示错误 | 0 on success, negative error code on failure
 */
int a6n_set_brightness(uint8_t brightness)
{
    // 直接写入Bank0 0xE2寄存器 | Write directly to Bank0 0xE2 register
    int ret = a6n_write_reg_bank(dev_a6n, 0, A6N_LCD_SB_REG, brightness);
    
    if (ret == 0)
    {
        LOG_INF("A6N brightness set to 0x%02X", brightness);
    }
    else
    {
        LOG_ERR("Failed to set brightness 0x%02X: %d", brightness, ret);
    }
    
    return ret;
}

/**
 * @brief 启用或关闭 A6N 面板的自测试显示模式 | Enable or disable the A6N panel built-in self-test pattern mode
 *
 * 自测试功能需要先配置 Bank1 寄存器，然后设置 Bank0 0x8F | Self-test requires Bank1 register configuration, then set Bank0 0x8F
 *
 * Bank1 初始化序列 | Bank1 initialization sequence:
 *   0x4D = 0x30, 0x4E = 0x20, 0x4F = 0x03, 0x50 = 0x14
 *   0x51 = 0x02, 0x52 = 0x0E, 0x53 = 0x02, 0x54 = 0x19
 *
 * Bank0 0x8F 自测试图案 | Bank0 0x8F self-test patterns:
 *   0x80 = 全黑图 (all black)
 *   0x81 = 全亮图 (all white)
 *   0x88 = 2x2 棋盘格 (2x2 checkerboard)
 *   0x89 = 4x4 棋盘格 (4x4 checkerboard)
 *
 * @param enable  是否启用测试模式 | Whether to enable test mode
 *                 true  = 启用自测试 (Enable test mode)
 *                 false = 关闭自测试 (Disable test mode)
 *
 * @param pattern 测试图案编号 | Test pattern ID:
 *                 0x00 = 全黑 (all black, maps to 0x80)
 *                 0x01 = 全亮 (all white, maps to 0x81)
 *                 0x08 = 2x2棋盘格 (2x2 checkerboard, maps to 0x88)
 *                 0x09 = 4x4棋盘格 (4x4 checkerboard, maps to 0x89)
 *
 * @return 0 表示成功；负数表示 SPI 写入错误 | 0 if successful, negative errno on SPI error
 * 
 * @note 注意事项 | Important notes:
 *       1. 内部测试图 APL 较高，需要设置较低亮度 | Internal test patterns have high APL, use low brightness
 *       2. 点亮时间尽可能短 | Keep display time as short as possible
 *       3. 首次调用会初始化 Bank1 寄存器 | First call initializes Bank1 registers
 */
int a6n_enable_selftest(bool enable, uint8_t pattern)
{
    static bool bank1_initialized = false;
    int err = 0;

    // 首次使用时初始化 Bank1 寄存器 | Initialize Bank1 registers on first use
    if (enable && !bank1_initialized)
    {
        LOG_INF("A6N: Initializing Bank1 registers for self-test");
        
        // Bank1 寄存器配置结构 | Bank1 register configuration structure
        typedef struct
        {
            uint8_t reg;  // 寄存器地址 | Register address
            uint8_t val;  // 寄存器值 | Register value
        } Bank1RegConfig;
        
        // Bank1 寄存器初始化序列 | Bank1 register initialization sequence
        static const Bank1RegConfig kBank1InitSequence[] = {
            {0x4D, 0x30},  // Bank1 寄存器 0x4D | Bank1 register 0x4D
            {0x4E, 0x20},  // Bank1 寄存器 0x4E | Bank1 register 0x4E
            {0x4F, 0x03},  // Bank1 寄存器 0x4F | Bank1 register 0x4F
            {0x50, 0x14},  // Bank1 寄存器 0x50 | Bank1 register 0x50
            {0x51, 0x02},  // Bank1 寄存器 0x51 | Bank1 register 0x51
            {0x52, 0x0E},  // Bank1 寄存器 0x52 | Bank1 register 0x52
            {0x53, 0x02},  // Bank1 寄存器 0x53 | Bank1 register 0x53
            {0x54, 0x19}   // Bank1 寄存器 0x54 | Bank1 register 0x54
        };
        
        // 依次写入 Bank1 寄存器 | Write Bank1 registers sequentially
        for (size_t i = 0; i < ARRAY_SIZE(kBank1InitSequence); i++)
        {
            err = a6n_write_reg_bank(dev_a6n, 1, kBank1InitSequence[i].reg, kBank1InitSequence[i].val);
            if (err != 0)
            {
                LOG_ERR("A6N: Bank1 init failed at reg=0x%02X", kBank1InitSequence[i].reg);
                return err;
            }
            mos_busy_wait(100);  // 寄存器间延时 | Delay between registers
        }
        
        bank1_initialized = true;
        LOG_INF("A6N: Bank1 initialized successfully for self-test");
    }

    // 映射测试图案编号到实际寄存器值 | Map test pattern ID to actual register value
    uint8_t reg_val;
    if (enable)
    {
        switch (pattern)
        {
            case 0x00:
                reg_val = 0x80;  // 全黑图 | All black
                break;
            case 0x01:
                reg_val = 0x81;  // 全亮图 | All white
                break;
            case 0x08:
                reg_val = 0x88;  // 2x2 棋盘格 | 2x2 checkerboard
                break;
            case 0x09:
                reg_val = 0x89;  // 4x4 棋盘格 | 4x4 checkerboard
                break;
            default:
                reg_val = 0x80 | (pattern & 0x0F);  // 其他图案 | Other patterns
                break;
        }
    }
    else
    {
        reg_val = 0x00;  // 关闭自测试 | Disable self-test
    }

    // 写入 Bank0 0x8F 寄存器（广播模式）| Write to Bank0 0x8F register (broadcast mode)
    err = a6n_write_reg_bank(dev_a6n, 0, A6N_LCD_SELFTEST_REG, reg_val);

    LOG_INF("A6N_selftest: enable=%d, pattern=0x%02X → reg_val=0x%02X", enable, pattern, reg_val);

    return err;
}

/**
 * @brief 设置镜像模式（简化接口） | Set mirror mode (simplified interface)
 * @param mode 镜像模式 | Mirror mode (MIRROR_NORMAL, MIRROR_HORZ, MIRROR_VERT, MIRROR_BOTH)
 * @return 成功返回0，失败返回负数错误码 | 0 on success, negative error code on failure
 * 
 * @note A6N 硬件仅支持水平镜像（根据最新规格书）| A6N hardware only supports horizontal mirroring (per latest specification)
 *       - MIRROR_NORMAL: 无镜像 | No mirroring
 *       - MIRROR_HORZ: 水平翻转（支持）| Horizontal flip (supported)
 *       - MIRROR_VERT: 硬件不支持，回退到无镜像 | Not supported by hardware, falls back to MIRROR_NORMAL
 *       - MIRROR_BOTH: 仅应用水平翻转（垂直不支持）| Only horizontal flip is applied (vertical not supported)
 */
int a6n_set_mirror(mirror_mode_t mode)
{
    if (mode > MIRROR_BOTH)
    {
        LOG_ERR("Invalid mirror mode: %d", mode);
        return -1;
    }
    
    // 使用 a6n_set_shift_mirror，默认居中位置 (8, 8) | Use a6n_set_shift_mirror with default center position (8, 8)
    // A6N 硬件仅支持水平镜像（根据最新规格书）| A6N hardware only supports horizontal mirroring per latest specification
    a6n_mirror_mode_t mirror_mode;
    switch (mode)
    {
        case MIRROR_NORMAL:
            mirror_mode = A6N_MIRROR_NORMAL;
            break;
        case MIRROR_HORZ:
        case MIRROR_BOTH:  // 硬件限制：仅支持水平翻转 | Hardware limitation: only horizontal flip supported
            mirror_mode = A6N_MIRROR_H_FLIP;
            break;
        case MIRROR_VERT:
            // 硬件限制：不支持单独垂直镜像 | Hardware limitation: vertical-only mirror not supported
            LOG_WRN("Vertical mirror not supported by A6N hardware, using normal mode");
            mirror_mode = A6N_MIRROR_NORMAL;
            break;
        default:
            LOG_ERR("Unsupported mirror mode: %d", mode);
            return -1;
    }

    int err = a6n_set_shift_mirror(8, 8, mirror_mode);
    LOG_INF("set_mirror: mode=%d → hw_mirror=%d, err=%d", mode, mirror_mode, err);
    return err;
}

/**
 * @brief 写入 Bank0/Bank1 寄存器（广播模式）| Write Bank0/Bank1 register value (broadcast mode)
 * @param bank_id Bank 号 (0=Bank0, 1=Bank1) | Bank number (0=Bank0, 1=Bank1)
 * @param reg 寄存器地址 | Register address to write
 * @param param 寄存器值 | Value to write to the register
 * @return 0 表示成功，负数表示错误 | 0 on success, negative error code on failure
 */
int a6n_write_reg(uint8_t bank_id, uint8_t reg, uint8_t param)
{
    LOG_INF("bspal_write_register bank:%d, reg:0x%02x, param:0x%02x", bank_id, reg, param);
    
    // 使用统一的 Bank 寄存器写入接口 | Use unified Bank register write interface
    int ret = a6n_write_reg_bank(dev_a6n, bank_id, reg, param);
    return ret;
}

/**
 * @brief 向指定 Bank 的寄存器写入数据（广播模式） | Write a value to a register in the specified Bank (broadcast mode)
 *
 * SPI 命令字根据 Bank 不同 | SPI command differs by Bank:
 *   Bank0 写命令: 0x78 (Write command for Bank0)
 *   Bank1 写命令: 0x7A (Write command for Bank1)
 *
 * 时序: CS拉低 → 发送命令字 → 发送寄存器地址 → 发送寄存器值 → CS拉高
 * Timing: CS low → Send command → Send register address → Send register value → CS high
 *
 * @param dev     保留参数，可传 NULL | Reserved parameter, can pass NULL
 * @param bank_id Bank 号 (0=Bank0, 1=Bank1) | Bank number (0=Bank0, 1=Bank1)
 * @param reg     寄存器地址 (8-bit) | Register address (8-bit)
 * @param val     寄存器值 (8-bit) | Register value (8-bit)
 *
 * @return 0 表示成功，负数表示 SPI 写入错误 | 0 on success, negative errno on SPI error
 * 
 * @note 不支持连续读写，只能一次读写一个寄存器 | Continuous read/write not supported, one register at a time
 */
int a6n_write_reg_bank(const struct device *dev, uint8_t bank_id, uint8_t reg, uint8_t val)
{
    const a6n_config *cfg = dev_a6n->config;
    
    // 根据 Bank 选择命令字 | Select command byte based on Bank
    // Bank0: 0x78, Bank1: 0x7A
    uint8_t cmd_byte = (bank_id == 0) ? A6N_LCD_WRITE_ADDRESS : A6N_LCD_BANK_SEL_REG;
    
    // 构造 SPI 数据包: [命令字, 寄存器地址, 寄存器值] | Build SPI packet: [command, register address, register value]
    uint8_t tx_data[3] = {cmd_byte, reg, val};
    struct spi_buf buf_data = {.buf = tx_data, .len = sizeof(tx_data)};
    struct spi_buf_set tx_data_set = {.buffers = &buf_data, .count = 1};

    // 广播模式：同时拉低左右 CS，发送数据，拉高 CS | Broadcast mode: pull both CS low, send data, pull CS high
    gpio_pin_set_dt(&cfg->left_cs, 0);   // 左 CS 拉低 | Left CS low
    gpio_pin_set_dt(&cfg->right_cs, 0);  // 右 CS 拉低 | Right CS low
    
    // ✅ FIX: 添加 CS setup time，确保左右光机同步 | Add CS setup time for sync
    k_busy_wait(1);  // 1us delay
    
    int ret = spi_write_dt(&cfg->spi, &tx_data_set);
    
    // ✅ FIX: 添加 CS hold time | Add CS hold time
    k_busy_wait(1);  // 1us delay
    
    gpio_pin_set_dt(&cfg->left_cs, 1);   // 左 CS 拉高 | Left CS high
    gpio_pin_set_dt(&cfg->right_cs, 1);  // 右 CS 拉高 | Right CS high

    if (ret == 0)
    {
        LOG_INF("A6N: [Bank%d] REG=0x%02X ← 0x%02X (cmd=0x%02X)", bank_id, reg, val, cmd_byte);
    }
    else
    {
        LOG_ERR("A6N: Write failed [Bank%d reg=0x%02X val=0x%02X] err=%d", bank_id, reg, val, ret);
    }

    return ret;
}

/**
 * @brief 从指定 Bank 的寄存器读取数据 | Read a value from a register in the specified Bank
 *
 * SPI 命令字根据 Bank 不同 | SPI command differs by Bank:
 *   Bank0 读命令: 0x79 (Read command for Bank0)
 *   Bank1 读命令: 0x7B (Read command for Bank1)
 *
 * @param bank_id Bank 号 (0=Bank0, 1=Bank1) | Bank number (0=Bank0, 1=Bank1)
 * @param mode    读取模式 (0=左光机, 1=右光机) | Read mode (0=left engine, 1=right engine)
 * @param reg     寄存器地址 (8-bit) | Register address (8-bit)
 *
 * @return 寄存器值 (成功) 或 负数错误码 (失败) | Register value on success, negative errno on failure
 */
int a6n_read_reg(uint8_t bank_id, int mode, uint8_t reg)
{
    if (mode < 0 || mode > 1)
    {
        LOG_WRN("Invalid mode err!!!");
        return -EINVAL;
    }
    
    // 根据 Bank 选择命令字 | Select command byte based on Bank
    // Bank0: 0x79, Bank1: 0x7B
    uint8_t cmd_byte = (bank_id == 0) ? A6N_LCD_READ_ADDRESS : A6N_LCD_BANK1_READ;
    
    uint8_t cmd[3] = {0};
    cmd[0] = cmd_byte;
    cmd[1] = reg;
    cmd[2] = 0;
    
    uint8_t rx_buff[10] = {0};
    const a6n_config *cfg  = dev_a6n->config;
    struct spi_buf buf = {
        .buf = cmd,
        .len = sizeof(cmd),
    };
    struct spi_buf_set tx_set = {
        .buffers = &buf,
        .count   = 1,
    };

    struct spi_buf rx_buf = {
        .buf = rx_buff,
        .len = sizeof(rx_buff),
    };
    struct spi_buf_set rx_set = {
        .buffers = &rx_buf,
        .count   = 1,
    };
    
    // 选择左或右光机 | Select left or right engine
    if (mode == 0)
    {
        gpio_pin_set_dt(&cfg->left_cs, 0);
    }
    else
    {
        gpio_pin_set_dt(&cfg->right_cs, 0);
    }
    
    int ret = spi_transceive_dt(&cfg->spi, &tx_set, &rx_set);
    
    if (mode == 0)
    {
        gpio_pin_set_dt(&cfg->left_cs, 1);
    }
    else
    {
        gpio_pin_set_dt(&cfg->right_cs, 1);
    }
    
    if (ret != 0)
    {
        LOG_WRN("SPI read_reg [Bank%d] @0x%02x failed: %d", bank_id, reg, ret);
        return ret;
    }
    
    LOG_INF("read [Bank%d] reg: 0x%02X, value: 0x%02X (cmd=0x%02X)", bank_id, reg, rx_buff[2], cmd_byte);
    return rx_buff[2];
}
static void *a6n_get_framebuffer(struct device *dev)
{
    return NULL;
}
/**
 * @brief Retrieves the capabilities of the display device
 * @param dev Display device handle
 * @param cap Pointer to the display device capability structure
 */
static int a6n_get_capabilities(struct device *dev, struct display_capabilities *cap)
{
    const a6n_config *cfg = (a6n_config *)dev->config;
    memset(cap, 0, sizeof(struct display_capabilities));
    cap->x_resolution = cfg->screen_width;
    cap->y_resolution = cfg->screen_height;
    cap->screen_info  = SCREEN_INFO_MONO_MSB_FIRST | SCREEN_INFO_X_ALIGNMENT_WIDTH;

    // cap->current_pixel_format    = PIXEL_FORMAT_MONO01;
    // cap->supported_pixel_formats = PIXEL_FORMAT_MONO01;
    cap->current_pixel_format = PIXEL_FORMAT_MONO10;
    cap->supported_pixel_formats = PIXEL_FORMAT_MONO10;
    cap->current_orientation = DISPLAY_ORIENTATION_NORMAL;
    return 0;
}
void a6n_power_on(void)
{
    LOG_INF("bsp_lcd_power_on");
    const a6n_config *cfg = (a6n_config *)dev_a6n->config;
    pm_device_action_run(dev_a6n, PM_DEVICE_ACTION_RESUME);
    k_msleep(50);
    // gpio_pin_set_dt(&cfg->v1_8, 1); // v1.8 high
    gpio_pin_set_dt(&cfg->v0_9, 1);  // v1.8 high
    k_msleep(10);
    // gpio_pin_set_dt(&cfg->v0_9, 1); // v0.9 high
    gpio_pin_set_dt(&cfg->v1_8, 1);  // v0.9 high
    k_msleep(10);
    gpio_pin_set_dt(&cfg->reset, 0); // reset low
    k_msleep(5);
    gpio_pin_set_dt(&cfg->reset, 1); // reset high
    k_msleep(300);
}

void a6n_power_off(void)
{
    LOG_INF("bsp_lcd_power_off");
    const a6n_config *cfg = (a6n_config *)dev_a6n->config;
    // display_blanking_on(dev_a6n);
    // spi_release_dt(&cfg->spi);
    gpio_pin_set_dt(&cfg->left_cs, 1);
    gpio_pin_set_dt(&cfg->right_cs, 1);
    pm_device_action_run(dev_a6n, PM_DEVICE_ACTION_SUSPEND);

    gpio_pin_set_dt(&cfg->vcom, 0);
    k_msleep(10);
    gpio_pin_set_dt(&cfg->v0_9, 0);
    k_msleep(10);
    gpio_pin_set_dt(&cfg->v1_8, 0);
}

int a6n_clear_screen(bool color_on)
{
    const a6n_config *cfg  = dev_a6n->config;
    a6n_data         *data = dev_a6n->data;

    uint16_t width  = cfg->screen_width;
    uint16_t height = SCREEN_HEIGHT;
    // Clear MAX_LINES_PER_WRITE lines each time
    uint8_t *tx_buf          = data->tx_buf_bulk;
    uint16_t lines_per_batch = MAX_LINES_PER_WRITE;
    uint16_t total_lines     = height;

    uint8_t  nib               = color_on ? 0x0F : 0x00;// 4-bit color value (0x0F=white, 0x00=black)
    uint8_t  fill_byte         = (uint8_t)((nib << 4) | nib);
    uint16_t i4_bytes_per_line = (width + 1U) / 2U;

    for (uint16_t y = 0; y < total_lines; y += lines_per_batch)
    {
        uint16_t batch_lines = MIN(lines_per_batch, total_lines - y);

        a6n_write_multiple_rows_cmd(dev_a6n, y, y + batch_lines - 1);
        tx_buf[0] = A6N_LCD_DATA_REG;
        tx_buf[1] = (A6N_LCD_CMD_REG >> 16) & 0xFF;
        tx_buf[2] = (A6N_LCD_CMD_REG >> 8) & 0xFF;
        tx_buf[3] = A6N_LCD_CMD_REG & 0xFF;

        for (uint16_t line = 0; line < batch_lines; line++)
        {
            memset(&tx_buf[4 + line * i4_bytes_per_line], fill_byte, i4_bytes_per_line);
        }
        int ret = a6n_transmit_all(dev_a6n, tx_buf, 4 + batch_lines * i4_bytes_per_line, 1);
        if (ret != 0)
        {
            LOG_ERR("a6n_transmit_all failed! (%d)", ret);
            return ret;
        }
    }
    return 0;
}

// **NEW: Direct A6N Grayscale Test Patterns**
// These functions bypass LVGL and directly access the A6N hardware for true 8-bit grayscale testing
/**
 * @brief Draw horizontal grayscale pattern with true 8-bit levels
 * @return 0 on success, negative on error
 */
int a6n_draw_horizontal_grayscale_pattern(void)
{
    if (!dev_a6n)
    {
        LOG_WRN("A6N device not initialized");
        return -ENODEV;
    }

    const a6n_config *cfg  = dev_a6n->config;
    a6n_data         *data = dev_a6n->data;

    uint16_t width             = cfg->screen_width;
    uint16_t height            = cfg->screen_height;
    uint16_t i4_bytes_per_line = (width + 1u) / 2u; /* 320 */
    // 8 grayscale levels: 0x00, 0x24, 0x49, 0x6D, 0x92, 0xB6, 0xDB, 0xFF
    uint8_t  gray_levels[8] = {0x00, 0x24, 0x49, 0x6D, 0x92, 0xB6, 0xDB, 0xFF};
    uint16_t stripe_width   = width / 8;  // 80 pixels per stripe

    uint8_t *tx_buf          = data->tx_buf_bulk;
    uint16_t lines_per_batch = MAX_LINES_PER_WRITE;

    LOG_INF("🎨 Drawing horizontal grayscale pattern (8 levels, %d pixels per stripe)", stripe_width);

    for (uint16_t y = 0; y < height; y += lines_per_batch)
    {
        uint16_t batch_lines = MIN(lines_per_batch, height - y);

        // Build data command header
        a6n_write_multiple_rows_cmd(dev_a6n, y, y + batch_lines - 1);
        tx_buf[0] = A6N_LCD_DATA_REG;
        tx_buf[1] = (A6N_LCD_CMD_REG >> 16) & 0xFF;
        tx_buf[2] = (A6N_LCD_CMD_REG >> 8) & 0xFF;
        tx_buf[3] = A6N_LCD_CMD_REG & 0xFF;

        for (uint16_t line = 0; line < batch_lines; line++)
        {
            uint8_t *dst = &tx_buf[4 + line * i4_bytes_per_line];
            uint16_t out = 0;
            for (uint16_t x = 0; x < width; x += 2u)
            {
                uint16_t s0 = (uint16_t)(x / stripe_width);
                if (s0 > 7) s0 = 7;
                uint16_t s1 = (uint16_t)((x + 1u) / stripe_width);
                if (s1 > 7) s1 = 7;
                uint8_t g0_4 = (uint8_t)(gray_levels[s0] >> 4);
                uint8_t g1_4 = (uint8_t)(gray_levels[s1] >> 4);

                dst[out++] = (uint8_t)((g0_4 << 4) | (g1_4 & 0x0F));
            }
        }

        int ret = a6n_transmit_all(dev_a6n, tx_buf, 4 + batch_lines * i4_bytes_per_line, 1);
        if (ret != 0)
        {
            LOG_WRN("a6n_transmit_all failed! (%d)", ret);
            return ret;
        }
    }

    LOG_INF("✅ Horizontal grayscale pattern completed");
    return 0;
}

/**
 * @brief Draw vertical grayscale pattern with true 8-bit levels
 * @return 0 on success, negative on error
 */
int a6n_draw_vertical_grayscale_pattern(void)
{
    if (!dev_a6n)
    {
        LOG_WRN("A6N device not initialized");
        return -ENODEV;
    }

    const a6n_config *cfg  = dev_a6n->config;
    a6n_data         *data = dev_a6n->data;

    uint16_t width             = cfg->screen_width;
    uint16_t height            = cfg->screen_height;
    uint16_t i4_bytes_per_line = (width + 1u) / 2u; /* 320 */
    // 8 grayscale levels: 0x00, 0x24, 0x49, 0x6D, 0x92, 0xB6, 0xDB, 0xFF
    uint8_t  gray_levels[8] = {0x00, 0x24, 0x49, 0x6D, 0x92, 0xB6, 0xDB, 0xFF};
    uint16_t stripe_height  = height / 8;  // 60 lines per stripe

    uint8_t *tx_buf          = data->tx_buf_bulk;
    uint16_t lines_per_batch = MAX_LINES_PER_WRITE;

    LOG_INF("🎨 Drawing vertical grayscale pattern (8 levels, %d lines per stripe)", stripe_height);

    for (uint16_t y = 0; y < height; y += lines_per_batch)
    {
        uint16_t batch_lines = (y + lines_per_batch <= height) ? lines_per_batch : (height - y);
        a6n_write_multiple_rows_cmd(dev_a6n, y, (uint16_t)(y + batch_lines - 1));

        tx_buf[0] = A6N_LCD_DATA_REG;
        tx_buf[1] = (A6N_LCD_CMD_REG >> 16) & 0xFF;
        tx_buf[2] = (A6N_LCD_CMD_REG >> 8) & 0xFF;
        tx_buf[3] = A6N_LCD_CMD_REG & 0xFF;

        for (uint16_t line = 0; line < batch_lines; line++)
        {
            uint16_t current_y = y + line;
            uint16_t band = (uint16_t)(current_y / stripe_height);
            if (band > 7) band = 7;

            uint8_t g4 = (uint8_t)(gray_levels[band] >> 4);
            uint8_t b  = (uint8_t)((g4 << 4) | g4); /* 两像素同灰度 */

            uint8_t *dst = &tx_buf[4 + line * i4_bytes_per_line];
            memset(dst, b, i4_bytes_per_line);
        }
        int ret = a6n_transmit_all(dev_a6n, tx_buf, 4 + batch_lines * i4_bytes_per_line, 1);
        if (ret != 0)
        {
            LOG_WRN("a6n_transmit_all failed! (%d)", ret);
            return ret;
        }
    }

    LOG_INF("✅ Vertical grayscale pattern completed");
    return 0;
}

/**
 * @brief Draw chess pattern for display testing
 * @return 0 on success, negative on error
 */
int a6n_draw_chess_pattern(void)
{
    if (!dev_a6n)
    {
        LOG_WRN("A6N device not initialized");
        return -ENODEV;
    }

    const a6n_config *cfg  = dev_a6n->config;
    a6n_data         *data = dev_a6n->data;

    uint16_t width             = cfg->screen_width;
    uint16_t height            = cfg->screen_height;
    uint16_t square_size       = 40;                // 40x40 pixel squares
    uint16_t i4_bytes_per_line = (width + 1u) / 2u; /* 320 */
    uint8_t *tx_buf            = data->tx_buf_bulk;
    uint16_t lines_per_batch   = MAX_LINES_PER_WRITE;

    LOG_INF("🎨 Drawing chess pattern (%dx%d squares)", square_size, square_size);
    for (uint16_t y = 0; y < height; y += lines_per_batch)
    {
        uint16_t batch_lines = (y + lines_per_batch <= height) ? lines_per_batch : (height - y);

        a6n_write_multiple_rows_cmd(dev_a6n, y, (uint16_t)(y + batch_lines - 1));

        tx_buf[0] = A6N_LCD_DATA_REG;
        tx_buf[1] = (A6N_LCD_CMD_REG >> 16) & 0xFF;
        tx_buf[2] = (A6N_LCD_CMD_REG >> 8) & 0xFF;
        tx_buf[3] = A6N_LCD_CMD_REG & 0xFF;

        for (uint16_t line = 0; line < batch_lines; line++)
        {
            uint16_t current_y = y + line;
            uint16_t row_block = (uint16_t)(current_y / square_size);

            uint8_t *dst = &tx_buf[4 + line * i4_bytes_per_line];
            uint16_t out = 0;

            for (uint16_t x = 0; x < width; x += 2u)
            {
                uint16_t col_block0 = (uint16_t)(x / square_size);
                bool     white0     = (((row_block + col_block0) & 1u) == 0u);
                uint8_t  px0_4      = white0 ? 0x0F : 0x00;

                uint8_t px1_4 = 0x00;
                if (x + 1u < width)
                {
                    uint16_t col_block1 = (uint16_t)((x + 1u) / square_size);
                    bool white1 = (((row_block + col_block1) & 1u) == 0u);
                    px1_4 = white1 ? 0x0F : 0x00;
                }

                dst[out++] = (uint8_t)((px0_4 << 4) | (px1_4 & 0x0F));
            }
        }

        int ret = a6n_transmit_all(dev_a6n, tx_buf, 4 + batch_lines * i4_bytes_per_line, 1);
        if (ret != 0)
        {
            LOG_WRN("a6n_transmit_all failed! (%d)", ret);
            return ret;
        }
    }

    LOG_INF("✅ Chess pattern completed");
    return 0;
}

void a6n_open_display(void)
{
    const a6n_config *cfg = dev_a6n->config;
    gpio_pin_set_dt(&cfg->vcom, 1);  // 开启显示；Enable display
}
/**
 * @brief Initializes the device
 * @param dev Device structure
 */
static int a6n_init(const struct device *dev)
{
    a6n_config *cfg  = (a6n_config *)dev->config;
    a6n_data   *data = (a6n_data *)dev->data;
    int              ret;
    // **NEW: Log SPI configuration for debugging**
    LOG_INF("🚀 A6N SPI Configuration:");
    LOG_INF("  - Device: %s", cfg->spi.bus->name);
    LOG_INF("  - Max Frequency: %d Hz (%.2f MHz)", cfg->spi.config.frequency,
            (float)cfg->spi.config.frequency / 1000000.0f);
    LOG_INF("  - Operation Mode: 0x%08X", cfg->spi.config.operation);
    LOG_INF("  - Slave ID: %d", cfg->spi.config.slave);

    if (!spi_is_ready_dt(&cfg->spi))
    {
        LOG_ERR("custom_a6n_init SPI device not ready");
        return -ENODEV;
    }
    if (!gpio_is_ready_dt(&cfg->left_cs))
    {
        LOG_ERR("GPIO left cs device not ready");
        return -ENODEV;
    }
    if (!gpio_is_ready_dt(&cfg->right_cs))
    {
        LOG_ERR("GPIO right cs device not ready");
        return -ENODEV;
    }
    if (!gpio_is_ready_dt(&cfg->reset))
    {
        LOG_ERR("GPIO reset device not ready");
        return -ENODEV;
    }
    if (!gpio_is_ready_dt(&cfg->vcom))
    {
        LOG_ERR("GPIO vcom device not ready");
        return -ENODEV;
    }
    if (!gpio_is_ready_dt(&cfg->v1_8))
    {
        LOG_ERR("GPIO v0_8 device not ready");
        return -ENODEV;
    }
    if (!gpio_is_ready_dt(&cfg->v0_9))
    {
        LOG_ERR("GPIO v0_9 device not ready");
        return -ENODEV;
    }
    /*******************************************************/
    ret = gpio_pin_configure_dt(&cfg->left_cs, GPIO_OUTPUT);
    if (ret < 0)
    {
        LOG_ERR("cs display failed! (%d)", ret);
        return ret;
    }
    ret = gpio_pin_set_dt(&cfg->left_cs, 1);
    if (ret < 0)
    {
        LOG_ERR("left_cs Enable display failed! (%d)", ret);
        return ret;
    }
    ret = gpio_pin_configure_dt(&cfg->right_cs, GPIO_OUTPUT);
    if (ret < 0)
    {
        LOG_ERR("right_cs display failed! (%d)", ret);
        return ret;
    }
    ret = gpio_pin_set_dt(&cfg->right_cs, 1);
    if (ret < 0)
    {
        LOG_ERR("right_cs Enable display failed! (%d)", ret);
        return ret;
    }
    ret = gpio_pin_configure_dt(&cfg->reset, GPIO_OUTPUT);
    if (ret < 0)
    {
        LOG_ERR("Reset display failed! (%d)", ret);
        return ret;
    }
    ret = gpio_pin_set_dt(&cfg->reset, 1);
    if (ret < 0)
    {
    	LOG_ERR("reset Enable display failed! (%d)", ret);
    	return ret;
    }

    ret = gpio_pin_configure_dt(&cfg->vcom, GPIO_OUTPUT);
    if (ret < 0)
    {
        LOG_ERR("vcom display failed! (%d)", ret);
        return ret;
    }
    ret = gpio_pin_set_dt(&cfg->vcom, 0);
    if (ret < 0)
    {
        LOG_ERR("vcom Enable display failed! (%d)", ret);
        return ret;
    }

    ret = gpio_pin_configure_dt(&cfg->v1_8, GPIO_OUTPUT);
    if (ret < 0)
    {
        LOG_ERR("v1_8 display failed! (%d)", ret);
        return ret;
    }
    ret = gpio_pin_set_dt(&cfg->v1_8, 0);
    if (ret < 0)
    {
        LOG_ERR("v1_8 Enable display failed! (%d)", ret);
        return ret;
    }

    ret = gpio_pin_configure_dt(&cfg->v0_9, GPIO_OUTPUT);
    if (ret < 0)
    {
        LOG_ERR("v0_9 display failed! (%d)", ret);
        return ret;
    }
    ret = gpio_pin_set_dt(&cfg->v0_9, 0);
    if (ret < 0)
    {
        LOG_ERR("v0_9 Enable display failed! (%d)", ret);
        return ret;
    }
    a6n_init_sem_give();
    data->initialized = true;

    // Simple blinking test - DISABLED to test LVGL patterns
    // LOG_INF("🔧 Starting simple blinking test (500ms on/off)...");
    //
    // for (int i = 0; i < 6; i++) {  // 3 full blink cycles
    // 	LOG_INF("💡 Blink %d: Display OFF", i/2 + 1);
    // 	a6n_clear_screen(false);  // Turn off
    // 	k_msleep(500);  // 500ms on
    //
    // 	LOG_INF("💡 Blink %d: Display ON", i/2 + 1);
    // 	a6n_clear_screen(true); // Turn on
    // 	k_msleep(500);  // 500ms off
    // }
    //
    // LOG_INF("🔧 Blinking test completed - leaving display ON");

    // Clear the display to start fresh for LVGL
    // LOG_INF("🧹 Clearing display for LVGL (setting to OFF/black)");
    // a6n_clear_screen(false);  // Start with display OFF (black)

    LOG_INF("Display initialized");
    return 0;
}
/********************************************************************************/

/* 驱动API注册; Driver API registration */
static DEVICE_API(display, a6n_api) = {
    .blanking_on      = a6n_blanking_on,
    .blanking_off     = a6n_blanking_off,
    .write            = a6n_write,
    .read             = a6n_read,
    .set_brightness   = a6n_set_brightness,    // 设置亮度；Set brightness
    .get_framebuffer  = a6n_get_framebuffer,   // 获取帧缓冲区；Get framebuffer
    .get_capabilities = a6n_get_capabilities,  // 获取显示能力；Get display capabilities
};
/* 每行 I4 字节数：两像素/字节 ; Number of I4 bytes per line: two pixels/byte */
#define A6M_I4_BYTES_PER_LINE(w) (((w) + 1U) / 2U)
#define CUSTOM_a6n_DEFINE(inst)                                                                                \
    static uint8_t                                                                                                  \
        a6n_bulk_tx_buffer_##inst[4 + MAX_LINES_PER_WRITE * A6M_I4_BYTES_PER_LINE(DT_INST_PROP(inst, width))]; \
    static a6n_config a6n_config_##inst = {                                                               \
        .spi           = SPI_DT_SPEC_INST_GET(inst, SPI_OP_MODE_MASTER | SPI_TRANSFER_MSB | SPI_WORD_SET(8U), 0U),  \
        .left_cs       = GPIO_DT_SPEC_INST_GET(inst, left_cs_gpios),                                                \
        .right_cs      = GPIO_DT_SPEC_INST_GET(inst, right_cs_gpios),                                               \
        .reset         = GPIO_DT_SPEC_INST_GET(inst, reset_gpios),                                                  \
        .vcom          = GPIO_DT_SPEC_INST_GET(inst, vcom_gpios),                                                   \
        .v1_8          = GPIO_DT_SPEC_INST_GET(inst, v1_8_gpios),                                                   \
        .v0_9          = GPIO_DT_SPEC_INST_GET(inst, v0_9_gpios),                                                   \
        .screen_width  = DT_INST_PROP(inst, width),                                                                 \
        .screen_height = DT_INST_PROP(inst, height),                                                                \
    };                                                                                                              \
                                                                                                                    \
    static a6n_data a6n_data_##inst = {                                                                   \
        .tx_buf_bulk   = a6n_bulk_tx_buffer_##inst,                                                            \
        .screen_width  = DT_INST_PROP(inst, width),                                                                 \
        .screen_height = DT_INST_PROP(inst, height),                                                                \
        .initialized   = false,                                                                                     \
    };                                                                                                              \
                                                                                                                    \
    DEVICE_DT_INST_DEFINE(inst, a6n_init, NULL, &a6n_data_##inst, &a6n_config_##inst, POST_KERNEL,   \
                          CONFIG_DISPLAY_INIT_PRIORITY, &a6n_api);

/* 为每个状态为"okay"的设备树节点创建实例；Create an instance for each device tree node with the status "okay"*/
DT_INST_FOREACH_STATUS_OKAY(CUSTOM_a6n_DEFINE)