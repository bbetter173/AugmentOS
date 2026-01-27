

target_include_directories(app PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include/.)
target_sources(app PRIVATE 
    ${CMAKE_CURRENT_SOURCE_DIR}/src/bspal_audio_i2s.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/opt3006.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/lsm6dsv16x.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/npm1300_led.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_button.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_jlink_usb_switch.c
    ${CMAKE_CURRENT_SOURCE_DIR}/src/mos_npm1300_ldsw.c
)