/*
 * Shell J-Link/USB Switch Control Module
 * 
 * Control P0.27 GPIO to switch between J-Link and USB modes
 * 控制 P0.27 GPIO 在 J-Link 和 USB 模式之间切换
 * 
 * Available Commands:
 * - jlink_usb help        : Show all J-Link/USB switch commands
 * - jlink_usb status      : Show current switch status
 * - jlink_usb jlink       : Switch to J-Link mode (GPIO HIGH)
 * - jlink_usb usb         : Switch to USB mode (GPIO LOW)
 * - jlink_usb toggle      : Toggle between J-Link and USB mode
 * 
 * Created: 2025-11-20
 * Author: MentraOS Team
 */

#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>
#include <zephyr/logging/log.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/init.h>

LOG_MODULE_REGISTER(shell_jlink_usb_switch, LOG_LEVEL_INF);

// GPIO control for J-Link/USB switch
#define USER_NODE DT_PATH(zephyr_user)
#if DT_NODE_EXISTS(USER_NODE) && DT_NODE_HAS_PROP(USER_NODE, jlink_usb_switch_gpios)
static const struct gpio_dt_spec jlink_usb_switch_gpio = GPIO_DT_SPEC_GET(USER_NODE, jlink_usb_switch_gpios);
static bool jlink_usb_gpio_initialized = false;
static bool current_mode_jlink = false;  // false = USB mode, true = J-Link mode

/**
 * Initialize J-Link/USB switch GPIO | 初始化J-Link/USB切换GPIO
 */
static int jlink_usb_gpio_init(void)
{
    if (jlink_usb_gpio_initialized)
    {
        return 0;  // Already initialized
    }
    
    if (!gpio_is_ready_dt(&jlink_usb_switch_gpio))
    {
        LOG_ERR("J-Link/USB switch GPIO port not ready");
        return -ENODEV;
    }
    
    // Configure as output, initial state HIGH (USB mode) | 配置为输出，初始状态为高电平（USB模式）
    // Hardware logic: HIGH = USB, LOW = J-Link | 硬件逻辑：高电平=USB，低电平=J-Link
    int ret = gpio_pin_configure_dt(&jlink_usb_switch_gpio, GPIO_OUTPUT_ACTIVE);
    if (ret != 0)
    {
        LOG_ERR("Failed to configure J-Link/USB switch GPIO: %d", ret);
        return ret;
    }
    
    // Explicitly set to HIGH to ensure initial state (USB mode) | 显式设置为高电平确保初始状态（USB模式）
    ret = gpio_pin_set_dt(&jlink_usb_switch_gpio, 1);
    if (ret != 0)
    {
        LOG_ERR("Failed to set J-Link/USB switch GPIO to HIGH: %d", ret);
        return ret;
    }
    
    current_mode_jlink = false;  // Start in USB mode | 从USB模式开始
    jlink_usb_gpio_initialized = true;
    LOG_INF("J-Link/USB switch GPIO (P0.27) initialized as output, initial state: HIGH (USB mode)");
    return 0;
}

/**
 * Initialize J-Link/USB switch GPIO at system startup | 系统启动时初始化J-Link/USB切换GPIO
 */
static int jlink_usb_gpio_sys_init(void)
{
    // Initialize GPIO to HIGH state (USB mode) at system startup | 系统启动时将GPIO初始化为高电平状态（USB模式）
    jlink_usb_gpio_init();
    return 0;
}

// Initialize GPIO at POST_KERNEL stage (after kernel is ready) | 在POST_KERNEL阶段初始化GPIO（内核就绪后）
SYS_INIT(jlink_usb_gpio_sys_init, POST_KERNEL, CONFIG_APPLICATION_INIT_PRIORITY);

/**
 * Set J-Link/USB switch GPIO state | 设置J-Link/USB切换GPIO状态
 * @param jlink_mode true for J-Link mode (LOW), false for USB mode (HIGH) | true为J-Link模式（低电平），false为USB模式（高电平）
 * @note Hardware logic: HIGH = USB, LOW = J-Link | 硬件逻辑：高电平=USB，低电平=J-Link
 */
static int jlink_usb_gpio_set(bool jlink_mode)
{
    if (!jlink_usb_gpio_initialized)
    {
        int ret = jlink_usb_gpio_init();
        if (ret != 0)
        {
            LOG_ERR("J-Link/USB GPIO init failed: %d", ret);
            return ret;
        }
    }
    
    // Hardware logic: HIGH = USB, LOW = J-Link | 硬件逻辑：高电平=USB，低电平=J-Link
    int ret = gpio_pin_set_dt(&jlink_usb_switch_gpio, jlink_mode ? 0 : 1);
    if (ret != 0)
    {
        LOG_ERR("Failed to set J-Link/USB switch GPIO to %s: %d", 
                jlink_mode ? "LOW (J-Link)" : "HIGH (USB)", ret);
        return ret;
    }
    
    current_mode_jlink = jlink_mode;
    LOG_INF("J-Link/USB switch GPIO (P1.11) set to %s (%s mode)", 
            jlink_mode ? "LOW" : "HIGH",
            jlink_mode ? "J-Link" : "USB");
    return 0;
}

/**
 * Get current switch mode | 获取当前切换模式
 */
static bool jlink_usb_get_mode(void)
{
    return current_mode_jlink;
}
#else
static int jlink_usb_gpio_init(void) { return 0; }
static int jlink_usb_gpio_set(bool jlink_mode) { (void)jlink_mode; return 0; }
static bool jlink_usb_get_mode(void) { return false; }
#endif

/**
 * J-Link/USB switch help command
 */
static int cmd_jlink_usb_help(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "");
    shell_print(shell, "🔌 J-Link/USB Switch Control Commands:");
    shell_print(shell, "");
    shell_print(shell, "📋 Commands:");
    shell_print(shell, "  jlink_usb help        - Show this help menu");
    shell_print(shell, "  jlink_usb status      - Show current switch status");
    shell_print(shell, "  jlink_usb jlink       - Switch to J-Link mode (GPIO LOW)");
    shell_print(shell, "  jlink_usb usb         - Switch to USB mode (GPIO HIGH)");
    shell_print(shell, "  jlink_usb toggle     - Toggle between J-Link and USB mode");
    shell_print(shell, "");
    shell_print(shell, "📊 GPIO Pin: P1.11");
    shell_print(shell, "  HIGH = USB mode");
    shell_print(shell, "  LOW  = J-Link mode");
    shell_print(shell, "");
    shell_print(shell, "📊 Examples:");
    shell_print(shell, "  jlink_usb status     - Check current mode");
    shell_print(shell, "  jlink_usb jlink       - Enable J-Link mode");
    shell_print(shell, "  jlink_usb usb         - Enable USB mode");
    shell_print(shell, "  jlink_usb toggle     - Switch to opposite mode");
    shell_print(shell, "");
    
    return 0;
}

/**
 * J-Link/USB switch status command
 */
static int cmd_jlink_usb_status(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "");
    shell_print(shell, "🔌 J-Link/USB Switch Status");
    shell_print(shell, "==========================================");
    shell_print(shell, "GPIO Pin:          P0.27");
    
#if DT_NODE_EXISTS(USER_NODE) && DT_NODE_HAS_PROP(USER_NODE, jlink_usb_switch_gpios)
    bool is_ready = jlink_usb_gpio_initialized;
    shell_print(shell, "GPIO Initialized:  %s", is_ready ? "✅ Yes" : "❌ No");
    
    if (is_ready)
    {
        bool mode = jlink_usb_get_mode();
        shell_print(shell, "Current Mode:      %s", mode ? "🔵 J-Link (LOW)" : "🟢 USB (HIGH)");
        shell_print(shell, "GPIO State:        %s", mode ? "LOW" : "HIGH");
    }
    else
    {
        shell_print(shell, "Current Mode:      ❌ Not initialized");
        shell_print(shell, "GPIO State:        ❌ Unknown");
    }
#else
    shell_print(shell, "GPIO Initialized:  ❌ Not configured in device tree");
    shell_print(shell, "Current Mode:      ❌ Not available");
    shell_print(shell, "GPIO State:        ❌ Not available");
    shell_print(shell, "");
    shell_warn(shell, "⚠️  J-Link/USB switch GPIO not defined in device tree");
    shell_print(shell, "   Add 'jlink_usb_switch-gpios = <&gpio0 27 GPIO_ACTIVE_HIGH>;' to zephyr,user node");
#endif
    
    shell_print(shell, "==========================================");
    shell_print(shell, "");
    
    return 0;
}

/**
 * J-Link/USB switch to J-Link mode command
 */
static int cmd_jlink_usb_jlink(const struct shell *shell, size_t argc, char **argv)
{
#if DT_NODE_EXISTS(USER_NODE) && DT_NODE_HAS_PROP(USER_NODE, jlink_usb_switch_gpios)
    int ret = jlink_usb_gpio_set(true);
    if (ret == 0)
    {
        shell_print(shell, "✅ Switched to J-Link mode (GPIO LOW)");
    }
    else
    {
        shell_error(shell, "❌ Failed to switch to J-Link mode: %d", ret);
    }
    return ret;
#else
    shell_error(shell, "❌ J-Link/USB switch GPIO not configured in device tree");
    return -ENOTSUP;
#endif
}

/**
 * J-Link/USB switch to USB mode command
 */
static int cmd_jlink_usb_usb(const struct shell *shell, size_t argc, char **argv)
{
#if DT_NODE_EXISTS(USER_NODE) && DT_NODE_HAS_PROP(USER_NODE, jlink_usb_switch_gpios)
    int ret = jlink_usb_gpio_set(false);
    if (ret == 0)
    {
        shell_print(shell, "✅ Switched to USB mode (GPIO HIGH)");
    }
    else
    {
        shell_error(shell, "❌ Failed to switch to USB mode: %d", ret);
    }
    return ret;
#else
    shell_error(shell, "❌ J-Link/USB switch GPIO not configured in device tree");
    return -ENOTSUP;
#endif
}

/**
 * J-Link/USB switch toggle command
 */
static int cmd_jlink_usb_toggle(const struct shell *shell, size_t argc, char **argv)
{
#if DT_NODE_EXISTS(USER_NODE) && DT_NODE_HAS_PROP(USER_NODE, jlink_usb_switch_gpios)
    bool current_mode = jlink_usb_get_mode();
    bool new_mode = !current_mode;
    
    int ret = jlink_usb_gpio_set(new_mode);
    if (ret == 0)
    {
        shell_print(shell, "✅ Toggled to %s mode (GPIO %s)", 
                    new_mode ? "J-Link" : "USB",
                    new_mode ? "LOW" : "HIGH");
    }
    else
    {
        shell_error(shell, "❌ Failed to toggle switch: %d", ret);
    }
    return ret;
#else
    shell_error(shell, "❌ J-Link/USB switch GPIO not configured in device tree");
    return -ENOTSUP;
#endif
}

/* Shell command definitions */
SHELL_STATIC_SUBCMD_SET_CREATE(sub_jlink_usb,
    SHELL_CMD(help, NULL, "Show J-Link/USB switch commands help", cmd_jlink_usb_help),
    SHELL_CMD(status, NULL, "Show current switch status", cmd_jlink_usb_status),
    SHELL_CMD(jlink, NULL, "Switch to J-Link mode (GPIO HIGH)", cmd_jlink_usb_jlink),
    SHELL_CMD(usb, NULL, "Switch to USB mode (GPIO LOW)", cmd_jlink_usb_usb),
    SHELL_CMD(toggle, NULL, "Toggle between J-Link and USB mode", cmd_jlink_usb_toggle),
    SHELL_SUBCMD_SET_END /* Array terminated. */
);

SHELL_CMD_REGISTER(jlink_usb, &sub_jlink_usb, "J-Link/USB switch control commands", cmd_jlink_usb_help);

