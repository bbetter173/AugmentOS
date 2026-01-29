/***
 * @Author       : Cole
 * @Date         : 2025-11-19 20:05:11
 * @LastEditTime : 2025-11-20 11:15:30
 * @FilePath     : lsm6dsv16x.h
 * @Description  : LSM6DSV16X 6-axis IMU sensor driver wrapper
 *                 LSM6DSV16X 6轴IMU传感器驱动封装
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef LSM6DSV16X_H_
#define LSM6DSV16X_H_

#include <stdbool.h>
#include <zephyr/device.h>
#include <zephyr/drivers/sensor.h>

/**
 * @brief Initialize LSM6DSV16X sensor | 初始化LSM6DSV16X传感器
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 * @note Uses Zephyr sensor framework, requires device tree configuration
 * @note 使用Zephyr传感器框架，需要设备树配置
 * @note Supports LSM6DSV16X with hardware sensor fusion (SFLP)
 * @note 支持LSM6DSV16X硬件传感器融合（SFLP）
 */
int lsm6dsv16x_init(void);

/**
 * @brief Check if sensor is ready | 检查传感器是否就绪
 * @return true if ready, false otherwise | 就绪返回true，否则返回false
 */
bool lsm6dsv16x_is_ready(void);

/**
 * @brief Read accelerometer data | 读取加速度计数据
 * @param accel_x Pointer to store X-axis acceleration (m/s²) | 存储X轴加速度的指针（m/s²）
 * @param accel_y Pointer to store Y-axis acceleration (m/s²) | 存储Y轴加速度的指针（m/s²）
 * @param accel_z Pointer to store Z-axis acceleration (m/s²) | 存储Z轴加速度的指针（m/s²）
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 */
int lsm6dsv16x_read_accel(float* accel_x, float* accel_y, float* accel_z);

/**
 * @brief Read gyroscope data | 读取陀螺仪数据
 * @param gyro_x Pointer to store X-axis angular velocity (dps) | 存储X轴角速度的指针（度/秒）
 * @param gyro_y Pointer to store Y-axis angular velocity (dps) | 存储Y轴角速度的指针（度/秒）
 * @param gyro_z Pointer to store Z-axis angular velocity (dps) | 存储Z轴角速度的指针（度/秒）
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 */
int lsm6dsv16x_read_gyro(float* gyro_x, float* gyro_y, float* gyro_z);

/**
 * @brief Read both accelerometer and gyroscope data | 同时读取加速度计和陀螺仪数据
 * @param accel_x Pointer to store X-axis acceleration | 存储X轴加速度的指针
 * @param accel_y Pointer to store Y-axis acceleration | 存储Y轴加速度的指针
 * @param accel_z Pointer to store Z-axis acceleration | 存储Z轴加速度的指针
 * @param gyro_x Pointer to store X-axis angular velocity | 存储X轴角速度的指针
 * @param gyro_y Pointer to store Y-axis angular velocity | 存储Y轴角速度的指针
 * @param gyro_z Pointer to store Z-axis angular velocity | 存储Z轴角速度的指针
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 */
int lsm6dsv16x_read_all(float* accel_x, float* accel_y, float* accel_z, float* gyro_x, float* gyro_y, float* gyro_z);

/**
 * @brief Set accelerometer sampling frequency | 设置加速度计采样频率
 * @param freq_hz Sampling frequency in Hz | 采样频率（Hz）
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 */
int lsm6dsv16x_set_accel_odr(uint16_t freq_hz);

/**
 * @brief Set gyroscope sampling frequency | 设置陀螺仪采样频率
 * @param freq_hz Sampling frequency in Hz | 采样频率（Hz）
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 */
int lsm6dsv16x_set_gyro_odr(uint16_t freq_hz);

/**
 * @brief Set accelerometer full scale range | 设置加速度计量程
 * @param range_g Full scale range in g (±2, ±4, ±8, ±16) | 量程（g）：±2, ±4, ±8, ±16
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 */
int lsm6dsv16x_set_accel_range(uint8_t range_g);

/**
 * @brief Set gyroscope full scale range | 设置陀螺仪量程
 * @param range_dps Full scale range in dps (±125, ±250, ±500, ±1000, ±2000) | 量程（度/秒）
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 */
int lsm6dsv16x_set_gyro_range(uint16_t range_dps);

/**
 * @brief Read device ID (WHO_AM_I register) | 读取器件ID（WHO_AM_I寄存器）
 * @param device_id Pointer to store device ID | 存储器件ID的指针
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 * @note Expected value for LSM6DSV16X is 0x70 | LSM6DSV16X的期望值是0x70
 */
int lsm6dsv16x_read_device_id(uint8_t* device_id);

/**
 * @brief Get sensor device pointer | 获取传感器设备指针
 * @return Pointer to sensor device, NULL if not initialized | 传感器设备指针，未初始化返回NULL
 * @note For advanced usage with Zephyr sensor API | 用于高级用法，配合Zephyr传感器API
 */
const struct device* lsm6dsv16x_get_device(void);

/**
 * @brief Initialize IMU control GPIO (start/stop, e.g. P1.05) | 初始化IMU控制GPIO（启停，如P1.05）
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 * @note Call from main.c at startup; GPIO is set LOW by default | 在 main.c 启动时调用；GPIO 默认为低电平
 */
int lsm6dsv16x_imu_ctrl_gpio_init(void);

/**
 * @brief Set IMU control GPIO state (start=HIGH, stop=LOW) | 设置IMU控制GPIO状态（启动=高，停止=低）
 * @param high true to set high (IMU on), false to set low (IMU off) | true 为高（IMU开），false 为低（IMU关）
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 */
int lsm6dsv16x_imu_ctrl_gpio_set(bool high);

#endif  // LSM6DSV16X_H_
