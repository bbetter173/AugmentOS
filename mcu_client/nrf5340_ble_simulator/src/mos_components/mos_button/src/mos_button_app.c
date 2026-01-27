/*
 * @Author       : Cole
 * @Date         : 2026-01-24 11:14:00
 * @LastEditTime : 2026-01-27 09:35:53
 * @FilePath     : mos_button_app.c
 * @Description  : 
 * 
 *  Copyright (c) MentraOS Contributors 2026 
 *  SPDX-License-Identifier: Apache-2.0
 */


#include "mos_button_app.h"

#include "mos_button.h"
#include "interrupt_handler.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/pm/device.h>
#include <zephyr/sys/poweroff.h>
#include <helpers/nrfx_reset_reason.h>
#include <display/lcd/a6n.h>  // For a6n_power_off()
#include "mos_lvgl_display.h"  // For set_display_onoff()

LOG_MODULE_REGISTER(mos_button_app, LOG_LEVEL_INF);

/* External function to pull down i2c3 pins (P1.04, P1.05) before sleep | 外部函数：在休眠前拉低i2c3引脚（P1.04, P1.05）*/
extern void pull_down_i2c3_pins_for_sleep(void);

/* Button press detection parameters | 按键按下检测参数 */
#define BUTTON_LONG_PRESS_MS 2500  // Long press threshold: 2.5 seconds | 长按阈值：2.5秒
#define BUTTON_POLL_INTERVAL_MS 50  // Polling interval: 50ms | 轮询间隔：50ms
#define BUTTON_DEBOUNCE_MS 20  // Debounce time: 20ms | 消抖时间：20ms

/* Button state tracking | 按键状态跟踪 */
static bool                        button_app_initialized = false;
static mos_button_app_callback_t   button_app_callback   = NULL;
static struct k_work_delayable     button_poll_work;      // 50ms定时器用于轮询按键状态 | 50ms timer for polling button state
static bool                        button_press_detected = false;
static int64_t                     button_press_start_time = 0;  // 按键按下开始时间 | Button press start time
static bool                        peripherals_turned_off = false;  // 外设是否已关闭 | Whether peripherals are turned off

/**
 * @brief Button polling handler | 按键轮询处理
 * 
 * Called every 50ms to check button state and accumulate press time | 每50ms调用一次检查按键状态并累计按下时间
 * Logic:
 * - If button is pressed: accumulate time, if >= 2.5s, turn off peripherals
 * - If button is released:
 *   - If peripherals already turned off (>= 2.5s pressed): enter sleep
 *   - If peripherals not turned off (< 2.5s pressed): short press, cancel timer, re-enable interrupt
 * 逻辑：
 * - 如果按键按下：累计时间，如果>=2.5s，关闭外设
 * - 如果按键松开：
 *   - 如果外设已关闭（>=2.5s按下）：进入休眠
 *   - 如果外设未关闭（<2.5s按下）：短按，取消定时器，重新使能中断
 */
static void button_poll_handler(struct k_work* work)
{
    ARG_UNUSED(work);

    if (!button_press_detected)
    {
        /* Button press was cancelled or reset | 按键按下已取消或重置 */
        return;
    }

    /* Check button state using GPIO polling (interrupt is disabled) | 使用GPIO轮询检查按键状态（中断已禁用）*/
    bool is_pressed = mos_button_is_pressed();
    
    if (!is_pressed)
    {
        /* Button is released - check if long press was completed | 按键已释放 - 检查是否已完成长按 */
        if (peripherals_turned_off)
        {
            /* Long press completed (>= 2.5s) and button released - enter sleep | 长按已完成（>=2.5s）且按键已释放 - 进入休眠 */
            LOG_INF("✅ Button released after long press (2.5s+) - entering System OFF sleep");
            button_press_detected = false;
            button_press_start_time = 0;
            peripherals_turned_off = false;
            mos_button_app_enter_sleep();
            /* Should not reach here | 不应该到达这里 */
            return;
        }
        else
        {
            /* Short press detected (released before 2.5s) - cancel polling, re-enable interrupt | 检测到短按（在2.5s前释放）- 取消轮询，重新使能中断 */
            int64_t press_duration = k_uptime_get() - button_press_start_time;
            LOG_INF("Button short press detected (duration: %lld ms, < 2.5s) - cancelling polling, re-enabling interrupt", press_duration);
            
            /* Cancel polling timer | 取消轮询定时器 */
            k_work_cancel_delayable(&button_poll_work);
            
            /* Reset button state | 重置按键状态 */
            button_press_detected = false;
            button_press_start_time = 0;
            peripherals_turned_off = false;
            
            /* Re-enable interrupt for next button event | 重新使能中断以便下次按键事件 */
            int ret = mos_button_re_enable_interrupt();
            if (ret != 0)
            {
                LOG_ERR("Failed to re-enable button interrupt: %d", ret);
            }
            
            /* Call short press callback if registered | 如果已注册，调用短按回调 */
            if (button_app_callback != NULL)
            {
                button_app_callback(MOS_BUTTON_PRESS_SHORT);
            }
            
            return;
        }
    }
    /* Button is still pressed - calculate press duration from interrupt time | 按键仍按下 - 计算从中断触发到现在的时长 */
    int64_t press_duration = k_uptime_get() - button_press_start_time;
    LOG_DBG("Button polling: press_duration = %lld ms, peripherals_turned_off = %d", press_duration, peripherals_turned_off);

    if (press_duration >= BUTTON_LONG_PRESS_MS && !peripherals_turned_off)
    {
        LOG_INF("✅ Button long press (2.5s) detected - turning off peripherals");
        
        /* Turn off peripherals | 关闭外设 */
        extern void vad_power_off(void);
        vad_power_off();  // Turn off VAD power on shutdown | 关机时关闭VAD电源
        
        mos_npm1300_ldsw1_disable(); 
        set_display_onoff(false);  // Set display state to off | 设置显示状态为关闭
        a6n_power_off();           // Turn off A6N display power | 关闭A6N显示电源
        a6n_io_off();            // Turn off A6N I/O power | 关闭A6N I/O电源
        peripherals_turned_off = true;
        LOG_INF("Peripherals turned off, waiting for button release to enter sleep");
    }

    /* Continue polling (schedule next check in 50ms) | 继续轮询（50ms后再次检查）*/
    k_work_schedule(&button_poll_work, K_MSEC(BUTTON_POLL_INTERVAL_MS));
}

/**
 * @brief Default button event handler | 默认按键事件处理函数
 * 
 * Note: Long press (2500ms) = enter sleep (handled in timeout handler)
 * 注意：长按（2500ms）= 进入休眠（在超时处理函数中处理）
 * Short press = reserved for future use
 * 短按 = 保留用于其他功能
 */
static void button_default_event_handler(mos_button_press_type_t press_type)
{
    if (press_type == MOS_BUTTON_PRESS_LONG)
    {
        /* This should not be called anymore - long press is handled in timeout handler | 这不应该再被调用 - 长按在超时处理函数中处理 */
        LOG_WRN("Button long press callback called (should be handled in timeout handler)");
    }
    else if (press_type == MOS_BUTTON_PRESS_SHORT)
    {
        LOG_DBG("Button short press: Reserved for future use");
        /* Short press can be used for other functions | 短按可用于其他功能 */
    }
}

/**
 * @brief Interrupt handler callback for button events | 按键事件的中断处理回调
 * 
 * This is called from the interrupt processing thread context | 从中断处理线程上下文调用
 */
static void button_interrupt_callback(interrupt_event_t* event)
{
    if (event == NULL)
    {
        return;
    }

    switch (event->event)
    {
        case INTERRUPT_TYPE_BUTTON_PRESSED:
        {
            int64_t interrupt_time = k_uptime_get();
            LOG_INF("Button interrupt received - configuring for polling, starting 20ms debounce");
            
            int ret = mos_button_configure_for_polling();
            if (ret != 0)
            {
                LOG_ERR("Failed to configure button GPIO for polling: %d", ret);
                break;
            }
            k_sleep(K_MSEC(BUTTON_DEBOUNCE_MS));
    
            bool is_pressed = mos_button_is_pressed();

            if (!is_pressed)
            {
                /* Button is released after debounce - ignore as bounce | 消抖后按键已释放 - 忽略（可能是抖动）*/
                LOG_INF("Button released after debounce (20ms) - ignoring as bounce (raw GPIO = %d)", is_pressed);
                
                ret = mos_button_re_enable_interrupt();
                if (ret != 0)
                {
                    LOG_ERR("Failed to re-enable button interrupt: %d", ret);
                }
                break;
            }
            
            /* Initialize button press tracking | 初始化按键按下跟踪 */
            button_press_detected = true;
            button_press_start_time = interrupt_time;  // Use interrupt time as start time | 使用中断时间作为开始时间
            peripherals_turned_off = false;
            
            k_work_schedule(&button_poll_work, K_MSEC(BUTTON_POLL_INTERVAL_MS));
           
        }
        break;
        default:
            LOG_WRN("Unknown button interrupt event type: %u", event->event);
        break;
    }
}

int mos_button_app_init(void)
{
    int ret;

    if (button_app_initialized)
    {
        LOG_WRN("Button app already initialized");
        return 0;
    }

    /* Initialize button driver | 初始化按键驱动 */
    ret = mos_button_init();
    if (ret != 0)
    {
        LOG_ERR("Failed to initialize button driver: %d", ret);
        return ret;
    }

    /* Initialize work for button polling (50ms interval) | 初始化按键轮询工作（50ms间隔）*/
    k_work_init_delayable(&button_poll_work, button_poll_handler);

    /* Check if interrupt handler framework is initialized | 检查中断处理框架是否已初始化 */
    if (!interrupt_handler_is_initialized())
    {
        LOG_ERR("Interrupt handler framework not initialized. Call interrupt_handler_init() first.");
        return -ENODEV;
    }

    /* Register interrupt callbacks for button events | 为按键事件注册中断回调 */
    ret = interrupt_handler_register_callback(INTERRUPT_TYPE_BUTTON_PRESSED, button_interrupt_callback);
    if (ret != 0)
    {
        LOG_ERR("Failed to register button pressed interrupt callback: %d", ret);
        return ret;
    }

    button_app_callback = button_default_event_handler;
    LOG_INF("Default button handler registered: long press (2500ms) = enter sleep, short press = reserved");

    button_app_initialized = true;
    LOG_INF("Button application logic initialized (using interrupt handler framework)");

    return 0;
}

int mos_button_app_register_callback(mos_button_app_callback_t callback)
{
    if (callback == NULL)
    {
        return -EINVAL;
    }

    button_app_callback = callback;
    LOG_INF("Button app callback registered");
    return 0;
}

void mos_button_app_unregister_callback(void)
{
    button_app_callback = NULL;
    LOG_INF("Button app callback unregistered");
}

int mos_button_app_enter_sleep(void)
{
    int ret;

    if (!button_app_initialized)
    {
        LOG_ERR("Button app not initialized");
        return -ENODEV;
    }

    LOG_INF("Preparing to enter System OFF sleep mode...");

    /* Cancel any pending button work | 取消任何待处理的按键工作 */
    k_work_cancel_delayable(&button_poll_work);
    
    /* Reset button state flags | 重置按键状态标志 */
    button_press_detected = false;
    button_press_start_time = 0;
    peripherals_turned_off = false;

    /* Unregister interrupt callbacks | 注销中断回调 */
    interrupt_handler_unregister_callback(INTERRUPT_TYPE_BUTTON_PRESSED, button_interrupt_callback);
    interrupt_handler_unregister_callback(INTERRUPT_TYPE_BUTTON_RELEASED, button_interrupt_callback);

    /* Note: Peripherals (like a6n_power_off) are already turned off in button_press_timeout_handler | 注意：外设（如a6n_power_off）已在button_press_timeout_handler中关闭 */
    /* Ensure VAD power is off before sleep (may already be off from button handler) | 确保休眠前VAD电源已关闭（可能已在按键处理中关闭）*/
    extern void vad_power_off(void);
    vad_power_off();
    
    /* Suspend SPI devices (use EasyDMA) | 挂起SPI设备（使用EasyDMA）*/
    // const struct device* spi4 = DEVICE_DT_GET(DT_NODELABEL(spi4));
    // if (device_is_ready(spi4))
    // {
    //     pm_device_action_run(spi4, PM_DEVICE_ACTION_SUSPEND);
    //     LOG_DBG("SPI4 suspended");
    // }
    /* Suspend I2C devices (use EasyDMA) | 挂起I2C设备（使用EasyDMA）*/
    // const struct device* i2c3 = DEVICE_DT_GET(DT_NODELABEL(i2c3));
    // if (device_is_ready(i2c3))
    // {
    //     pm_device_action_run(i2c3, PM_DEVICE_ACTION_SUSPEND);
    //     LOG_DBG("I2C3 suspended");
    // }

    /* Pull down i2c3 pins (P1.04, P1.05) before sleep | 在休眠前拉低i2c3引脚（P1.04, P1.05）*/
    pull_down_i2c3_pins_for_sleep();

    /* Configure button for System OFF wakeup | 配置按键用于System OFF唤醒 */
    ret = mos_button_configure_wakeup();
    if (ret != 0)
    {
        LOG_ERR("Failed to configure button for wakeup: %d", ret);
        return ret;
    }

    LOG_INF("Entering System OFF sleep mode...");
    LOG_INF("Press button to wake up");

    /* Enter System OFF - this will not return | 进入System OFF - 这不会返回 */
    sys_poweroff();

    /* Should never reach here | 不应该到达这里 */
    return -EIO;
}

bool mos_button_app_is_waking_from_sleep(void)
{
    /* Check if device is waking from System OFF via GPIO | 检查设备是否通过GPIO从System OFF唤醒 */
    /* System OFF wakeup causes a reset, so we check reset reason | System OFF唤醒会导致复位，所以检查复位原因 */
    /* Note: Only GPIO wakeup is considered as "waking from sleep" | 注意：只有GPIO唤醒才被认为是"从休眠唤醒" */
    /* Power-on reset (重新上电) is NOT considered as wakeup | 重新上电不被认为是唤醒 */
    uint32_t reset_reason = nrfx_reset_reason_get();
    
    /* Check if reset reason is System OFF wakeup (GPIO) | 检查复位原因是否为System OFF唤醒（GPIO）*/
    /* NRFX_RESET_REASON_OFF_MASK should only include GPIO wakeup from System OFF | NRFX_RESET_REASON_OFF_MASK应该只包括从System OFF的GPIO唤醒 */
    bool gpio_wakeup = (reset_reason & NRFX_RESET_REASON_OFF_MASK) != 0;
    
    /* Additional check: ensure it's not a power-on reset | 额外检查：确保不是重新上电复位 */
    /* Power-on reset typically has no specific reset reason flags set, or has different flags | 重新上电复位通常没有设置特定的复位原因标志，或有不同的标志 */
    /* If reset_reason is 0 or only has non-OFF flags, it's likely a power-on reset | 如果reset_reason为0或只有非OFF标志，可能是重新上电复位 */
    if (gpio_wakeup)
    {
        /* Clear reset reason | 清除复位原因 */
        nrfx_reset_reason_clear(reset_reason);
        LOG_INF("Device waking from System OFF (GPIO wakeup), reset_reason: 0x%08X", reset_reason);
        return true;
    }
    else
    {
        /* Not a GPIO wakeup - could be power-on reset or other reset | 不是GPIO唤醒 - 可能是重新上电复位或其他复位 */
        if (reset_reason != 0)
        {
            LOG_INF("Device reset detected (not GPIO wakeup), reset_reason: 0x%08X - normal startup", reset_reason);
            /* Clear reset reason for other resets too | 也清除其他复位原因 */
            nrfx_reset_reason_clear(reset_reason);
        }
        else
        {
            LOG_INF("Device power-on reset detected (reset_reason: 0) - normal startup");
        }
        return false;
    }
}

int mos_button_app_wait_for_power_on(uint32_t timeout_ms)
{
    int ret;
    bool long_press_detected = false;
    int64_t start_time = k_uptime_get();
    int64_t timeout_time = start_time + timeout_ms;
    int64_t button_press_start_time = 0;
    bool button_was_pressed = false;

    LOG_INF("Waiting for button long press (2500ms) to power on...");
    LOG_INF("Press and hold button for 2.5 seconds to start device");

    ret = mos_button_init();
    if (ret != 0)
    {
        LOG_ERR("Failed to initialize button driver: %d", ret);
        return ret;
    }

    /* Check button state immediately after wakeup | 唤醒后立即检查按键状态 */
    /* If button is not pressed, it means it was a short press that woke the device | 如果按键未按下，说明是短按唤醒了设备 */
    /* In this case, enter sleep again immediately | 这种情况下，立即再次进入休眠 */
    /* Wait longer for GPIO to stabilize after wakeup | 等待更长时间让GPIO在唤醒后稳定 */
    k_sleep(K_MSEC(100));  // Delay to allow GPIO to stabilize | 延迟以允许GPIO稳定
    
    /* Check button state multiple times to ensure accuracy | 多次检查按键状态以确保准确性 */
    int not_pressed_count = 0;
    int check_count = 0;
    for (int i = 0; i < 5; i++)
    {
        if (!mos_button_is_pressed())
        {
            not_pressed_count++;
        }
        check_count++;
        k_sleep(K_MSEC(10));  // Small delay between checks | 检查之间的小延迟
    }
    
    LOG_INF("Button state check: pressed=%d/%d times", (check_count - not_pressed_count), check_count);
    
    /* If button is not pressed in most checks, it's a short press wakeup | 如果大多数检查中按键未按下，说明是短按唤醒 */
    if (not_pressed_count >= 3)
    {
        /* Button is not pressed - short press wakeup, enter sleep again | 按键未按下 - 短按唤醒，再次进入休眠 */
        LOG_INF("Button not pressed after wakeup (short press detected, %d/%d checks) - entering sleep again", 
                not_pressed_count, check_count);
        
        /* Configure button for System OFF wakeup and enter sleep | 配置按键用于System OFF唤醒并进入休眠 */
        /* Note: We can't use mos_button_app_enter_sleep() here because button_app is not initialized yet | 注意：这里不能使用mos_button_app_enter_sleep()，因为按键应用尚未初始化 */
        ret = mos_button_configure_wakeup();
        if (ret != 0)
        {
            LOG_ERR("Failed to configure button for wakeup: %d", ret);
            return ret;
        }
        
        LOG_INF("Entering System OFF sleep mode (short press wakeup)...");
        sys_poweroff();
        /* Should not reach here | 不应该到达这里 */
        return -EIO;
    }

    /* Button is already pressed when waking up - start timing immediately | 唤醒时按键已经按下 - 立即开始计时 */
    LOG_INF("Button is already pressed on wakeup - starting long press detection immediately");
    button_press_start_time = k_uptime_get();
    button_was_pressed = true;
    bool long_press_reached = false;  // Flag to track if 2.5s has been reached | 标志：是否已达到2.5s

    /* Wait for button long press: press duration >= 2.5s, then release | 等待按键长按：按下时长 >= 2.5秒，然后释放 */
    /* If released before 2.5s, enter sleep again | 如果在2.5s前释放，再次进入休眠 */
    /* If pressed for >= 2.5s but not released, wait for release | 如果按下>=2.5s但未释放，等待释放 */
    while (!long_press_detected && (k_uptime_get() < timeout_time))
    {
        bool button_is_pressed = mos_button_is_pressed();
        int64_t current_time = k_uptime_get();

        if (button_is_pressed)
        {
            if (!button_was_pressed)
            {
                /* Button just pressed - record start time | 按键刚按下 - 记录开始时间 */
                button_press_start_time = current_time;
                button_was_pressed = true;
                long_press_reached = false;
                LOG_INF("Button pressed, starting long press detection (need 2.5s, then release)");
            }
            else
            {
                /* Button still pressed - check if long press duration reached | 按键仍按下 - 检查是否达到长按时长 */
                int64_t press_duration = current_time - button_press_start_time;
                if (press_duration >= BUTTON_LONG_PRESS_MS && !long_press_reached)
                {
                    /* Long press duration reached (2.5s) - now wait for release | 达到长按时长（2.5s）- 现在等待释放 */
                    LOG_INF("Button long press (2500ms) reached - waiting for button release to power on");
                    long_press_reached = true;
                }
            }
        }
        else
        {
            if (button_was_pressed)
            {
                /* Button was released | 按键已释放 */
                int64_t press_duration = current_time - button_press_start_time;
                if (press_duration < BUTTON_LONG_PRESS_MS)
                {
                    /* Released before 2.5s - enter sleep again | 在2.5s前释放 - 再次进入休眠 */
                    LOG_INF("Button released after %lld ms (need 2500ms) - entering sleep again", press_duration);
                    ret = mos_button_configure_wakeup();
                    if (ret != 0)
                    {
                        LOG_ERR("Failed to configure button for wakeup: %d", ret);
                        return ret;
                    }
                    LOG_INF("Entering System OFF sleep mode...");
                    sys_poweroff();
                    /* Should not reach here | 不应该到达这里 */
                    return -ETIMEDOUT;
                }
                else if (long_press_reached)
                {
                    /* Released after 2.5s - condition met! | 在2.5s后释放 - 条件满足！ */
                    LOG_INF("Button released after long press (2.5s+) - powering on device");
                    long_press_detected = true;
                    break;
                }
                else
                {
                    /* This shouldn't happen - button was pressed but long_press_reached is false | 这不应该发生 - 按键已按下但long_press_reached为false */
                    LOG_WRN("Button released but long_press_reached is false (duration: %lld ms)", press_duration);
                    button_was_pressed = false;
                    button_press_start_time = 0;
                }
            }
        }

        k_sleep(K_MSEC(50));  // Check every 50ms | 每50ms检查一次
    }
    
    /* If timeout reached but button is still pressed after 2.5s, wait for release | 如果超时但按键在2.5s后仍按下，等待释放 */
    if (!long_press_detected && long_press_reached)
    {
        LOG_INF("Timeout reached but button still pressed after 2.5s - waiting for release to power on");
        while (mos_button_is_pressed() && (k_uptime_get() < timeout_time + 10000))  // Wait up to 10s more | 最多再等待10秒
        {
            k_sleep(K_MSEC(50));
        }
        
        if (!mos_button_is_pressed())
        {
            LOG_INF("Button released after 2.5s - powering on device");
            long_press_detected = true;
        }
        else
        {
            LOG_WRN("Button still pressed after extended wait - entering sleep");
            ret = mos_button_configure_wakeup();
            if (ret != 0)
            {
                LOG_ERR("Failed to configure button for wakeup: %d", ret);
                return ret;
            }
            LOG_INF("Entering System OFF sleep mode...");
            sys_poweroff();
            return -ETIMEDOUT;
        }
    }

    if (long_press_detected)
    {
        LOG_INF("Power-on long press confirmed - device will start normally");
        
        /* If button is still pressed after power-on, wait for release | 如果开机后按键仍按着，等待释放 */
        /* This ensures that button app can work normally (won't enter sleep while button is held) 
        | 这确保按键应用可以正常工作（按键按住时不会进入休眠）*/
        if (mos_button_is_pressed())
        {
            LOG_INF("Button is still pressed after power-on - waiting for release before enabling normal operation");
            int64_t wait_start = k_uptime_get();
            while (mos_button_is_pressed() && (k_uptime_get() - wait_start < 10000))  // Max 10s wait | 最多等待10秒
            {
                k_sleep(K_MSEC(50));
            }
            
            if (mos_button_is_pressed())
            {
                LOG_WRN("Button still pressed after 10s wait - continuing anyway");
            }
            else
            {
                LOG_INF("Button released - ready for normal operation");
            }
            
            /* Wait a bit for button to stabilize | 等待按键稳定 */
            k_sleep(K_MSEC(100));
        }
        
        return 0;
    }
    else
    {
        LOG_WRN("Power-on long press not detected within timeout (%u ms) - entering sleep again", timeout_ms);
        return -ETIMEDOUT;
    }
}
