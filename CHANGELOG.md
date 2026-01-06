# Changelog

## [Unreleased]
### Changed
- Increased A6N projector container width to 470 pixels for live caption display.
- Container border hidden, text center-aligned, and secondary font set to lv_font_montserrat_24 for A6N projector live caption container.
- Simplified container initial text to show simple welcome message with device name when glasses are disconnected/unpaired.

### Fixed
- A6N brightness control: Fixed BLE protobuf handler to use linear 0x00-0xFF register mapping instead of 0-9 levels, ensuring consistent brightness behavior between shell commands and mobile app.
- Shell brightness command now accepts any value 0-100 with linear mapping instead of fixed levels (20,40,60,80,100).
- Modular display configuration updates for improved UI consistency.

