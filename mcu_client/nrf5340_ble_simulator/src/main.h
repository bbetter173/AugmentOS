#ifndef MAIN_H
#define MAIN_H

/**
 * @brief Get the current BLE device name (includes MAC address suffix)
 * @return Pointer to the device name string (e.g., "Display-A1B2C3")
 */
const char *get_ble_device_name(void);

#endif /* MAIN_H */