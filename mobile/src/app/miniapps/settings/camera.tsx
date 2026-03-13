import {getModelCapabilities} from "@/../../cloud/packages/types/src"
import {View, ScrollView, TouchableOpacity, ViewStyle, TextStyle} from "react-native"

import {Icon, Text, Screen, Header} from "@/components/ignite"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import Toast from "react-native-toast-message"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {spacing, ThemedStyle} from "@/theme"
import CoreModule from "core"

type PhotoSize = "small" | "medium" | "large"
type VideoResolution = "720p" | "1080p" // | "1440p" | "4K"
type MaxRecordingTime = "3m" | "5m" | "10m" | "15m" | "20m"
type CameraFov = 82 | 92 | 102
type CameraRoiPosition = 0 | 1 | 2 // 0=Center, 1=Bottom, 2=Top

const PHOTO_SIZE_LABELS: Record<PhotoSize, string> = {
  small: "Low (960×720)",
  medium: "Medium (1440×1088)",
  large: "High (3264×2448)",
}

const VIDEO_RESOLUTION_LABELS: Record<VideoResolution, string> = {
  "720p": "720p (1280×720)",
  "1080p": "1080p (1920×1080)",
  // "1440p": "1440p (2560×1920)",
  // "4K": "4K (3840×2160)",
}

const MAX_RECORDING_TIME_LABELS: Record<MaxRecordingTime, string> = {
  "3m": "3 minutes",
  "5m": "5 minutes",
  "10m": "10 minutes",
  "15m": "15 minutes",
  "20m": "20 minutes",
}

const CAMERA_FOV_LABELS: Record<CameraFov, string> = {
  82: "82°",
  92: "92°",
  102: "102°",
}

const CAMERA_ROI_LABELS: Record<CameraRoiPosition, string> = {
  0: "Center",
  1: "Bottom",
  2: "Top",
}

export default function CameraSettingsScreen() {
  const {theme, themed} = useAppTheme()
  const {goBack} = useNavigationHistory()
  const [_devMode, _setDevMode] = useSetting(SETTINGS.dev_mode.key)
  const [photoSize, setPhotoSize] = useSetting(SETTINGS.button_photo_size.key)
  const [_ledEnabled, setLedEnabled] = useSetting(SETTINGS.button_camera_led.key)
  const [videoSettings, setVideoSettings] = useSetting(SETTINGS.button_video_settings.key)
  const [maxRecordingTime, setMaxRecordingTime] = useSetting(SETTINGS.button_max_recording_time.key)
  const [cameraFovSetting, setCameraFovSetting] = useSetting(SETTINGS.camera_fov.key)
  const [postProcessing, setPostProcessing] = useSetting(SETTINGS.media_post_processing.key)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const glassesConnected = useGlassesStore((state) => state.connected)

  const currentFov: CameraFov =
    cameraFovSetting?.fov === 82 || cameraFovSetting?.fov === 92 || cameraFovSetting?.fov === 102
      ? (cameraFovSetting.fov as CameraFov)
      : 102
  const currentRoi: CameraRoiPosition =
    typeof cameraFovSetting?.roi_position === "number" && cameraFovSetting.roi_position >= 0 && cameraFovSetting.roi_position <= 2
      ? (cameraFovSetting.roi_position as CameraRoiPosition)
      : 0

  // Derive video resolution from settings
  const videoResolution: VideoResolution = (() => {
    if (!videoSettings) return "1080p"
    if (videoSettings.width >= 3840) return "4K"
    if (videoSettings.width >= 2560) return "1440p"
    if (videoSettings.width >= 1920) return "1080p"
    return "720p"
  })()

  const handlePhotoSizeChange = async (size: PhotoSize) => {
    if (!glassesConnected) {
      console.log("Cannot change photo size - glasses not connected")
      return
    }

    try {
      setPhotoSize(size)
      await CoreModule.updateButtonPhotoSize(size)
    } catch (error) {
      console.error("Failed to update photo size:", error)
    }
  }

  const handleVideoResolutionChange = async (resolution: VideoResolution) => {
    if (!glassesConnected) {
      console.log("Cannot change video resolution - glasses not connected")
      return
    }

    try {
      // Convert resolution to width/height/fps
      const width = resolution === "4K" ? 3840 : resolution === "1440p" ? 2560 : resolution === "1080p" ? 1920 : 1280
      const height = resolution === "4K" ? 2160 : resolution === "1440p" ? 1920 : resolution === "1080p" ? 1080 : 720
      const fps = resolution === "4K" ? 15 : 30

      setVideoSettings({width, height, fps})
    } catch (error) {
      console.error("Failed to update video resolution:", error)
    }
  }

  const _handleLedToggle = async (enabled: boolean) => {
    if (!glassesConnected) {
      console.log("Cannot toggle LED - glasses not connected")
      return
    }

    try {
      setLedEnabled(enabled)
    } catch (error) {
      console.error("Failed to update LED setting:", error)
    }
  }

  const handleMaxRecordingTimeChange = async (time: MaxRecordingTime) => {
    if (!glassesConnected) {
      console.log("Cannot change max recording time - glasses not connected")
      return
    }

    try {
      const minutes = parseInt(time.replace("m", ""))
      setMaxRecordingTime(minutes)
    } catch (error) {
      console.error("Failed to update max recording time:", error)
    }
  }

  const handleCameraFovChange = (fov: CameraFov, roi_position: CameraRoiPosition) => {
    if (!glassesConnected) {
      console.log("Cannot change camera FOV - glasses not connected")
      return
    }
    try {
      setCameraFovSetting({fov, roi_position})
      Toast.show({type: "info", text1: translate("settings:cameraRestartBanner")})
    } catch (error) {
      console.error("Failed to update camera FOV:", error)
    }
  }

  // Check if glasses support camera button feature using capabilities
  const features = getModelCapabilities(defaultWearable)
  const supportsCameraButton = features?.hasButton && features?.hasCamera

  if (!supportsCameraButton) {
    return (
      <Screen preset="fixed">
        <Header leftIcon="chevron-left" onLeftPress={() => goBack()} title={translate("settings:cameraSettings")} />
        <View style={themed($emptyStateContainer)}>
          <Text style={themed($emptyStateText)}>Camera settings are not available for this device.</Text>
        </View>
      </Screen>
    )
  }

  return (
    <Screen preset="fixed">
      <Header leftIcon="chevron-left" onLeftPress={() => goBack()} title={translate("settings:cameraSettings")} />
      <ScrollView
        style={{marginRight: -theme.spacing.s4, paddingRight: theme.spacing.s4}}
        contentInsetAdjustmentBehavior="automatic">
        <View style={themed($settingsGroup)}>
          <Text style={themed($settingLabel)}>Action Button Photo Settings</Text>
          <Text style={themed($settingSubtitle)}>Choose the resolution for photos taken with the action button.</Text>

          {Object.entries(PHOTO_SIZE_LABELS).map(([value, label], index, arr) => {
            const isFirst = index === 0
            const isLast = index === arr.length - 1
            return (
              <TouchableOpacity
                key={value}
                style={[
                  themed($optionItem),
                  {
                    borderTopLeftRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
                    borderTopRightRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
                    borderBottomLeftRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
                    borderBottomRightRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
                    borderWidth: photoSize === value ? 1 : undefined,
                    borderColor: photoSize === value ? theme.colors.primary : undefined,
                  },
                ]}
                onPress={() => handlePhotoSizeChange(value as PhotoSize)}>
                <Text style={themed($optionText)}>{label}</Text>
                {photoSize === value && <Icon name="check" size={24} color={theme.colors.primary} />}
              </TouchableOpacity>
            )
          })}
        </View>

        <View style={themed($settingsGroup)}>
          <Text style={themed($settingLabel)}>Action Button Video Settings</Text>
          <Text style={themed($settingSubtitle)}>
            Choose the resolution for videos recorded with the action button.
          </Text>

          {Object.entries(VIDEO_RESOLUTION_LABELS).map(([value, label], index, arr) => {
            const isFirst = index === 0
            const isLast = index === arr.length - 1
            return (
              <TouchableOpacity
                key={value}
                style={[
                  themed($optionItem),
                  {
                    borderTopLeftRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
                    borderTopRightRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
                    borderBottomLeftRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
                    borderBottomRightRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
                    borderWidth: videoResolution === value ? 1 : undefined,
                    borderColor: videoResolution === value ? theme.colors.primary : undefined,
                  },
                ]}
                onPress={() => handleVideoResolutionChange(value as VideoResolution)}>
                <Text style={themed($optionText)}>{label}</Text>
                {videoResolution === value && <Icon name="check" size={24} color={theme.colors.primary} />}
              </TouchableOpacity>
            )
          })}
        </View>

        <View style={themed($settingsGroup)}>
          <Text style={themed($settingLabel)}>Maximum Recording Time</Text>
          <Text style={themed($settingSubtitle)}>Maximum duration for button-triggered video recording</Text>

          {Object.entries(MAX_RECORDING_TIME_LABELS).map(([value, label], index, arr) => {
            const isFirst = index === 0
            const isLast = index === arr.length - 1
            return (
              <TouchableOpacity
                key={value}
                style={[
                  themed($optionItem),
                  {
                    borderTopLeftRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
                    borderTopRightRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
                    borderBottomLeftRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
                    borderBottomRightRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
                    borderWidth: maxRecordingTime === parseInt(value.replace("m", "")) ? 1 : undefined,
                    borderColor:
                      maxRecordingTime === parseInt(value.replace("m", "")) ? theme.colors.primary : undefined,
                  },
                ]}
                onPress={() => handleMaxRecordingTimeChange(value as MaxRecordingTime)}>
                <Text style={themed($optionText)}>{label}</Text>
                {maxRecordingTime === parseInt(value.replace("m", "")) && (
                  <Icon name="check" size={24} color={theme.colors.primary} />
                )}
              </TouchableOpacity>
            )
          })}
        </View>

        <View style={themed($settingsGroup)}>
          <Text style={themed($settingLabel)}>Camera field of view</Text>
          <Text style={themed($settingSubtitle)}>FOV and ROI for the camera (K900 / Mentra Live).</Text>

          <Text style={[themed($settingSubtitle), {marginTop: theme.spacing.s2}]}>FOV</Text>
          {([82, 92, 102] as const).map((fov, index, arr) => {
            const isFirst = index === 0
            const isLast = index === arr.length - 1
            return (
              <TouchableOpacity
                key={fov}
                style={[
                  themed($optionItem),
                  {
                    borderTopLeftRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
                    borderTopRightRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
                    borderBottomLeftRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
                    borderBottomRightRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
                    borderWidth: currentFov === fov ? 1 : undefined,
                    borderColor: currentFov === fov ? theme.colors.primary : undefined,
                  },
                ]}
                onPress={() => handleCameraFovChange(fov, currentRoi)}>
                <Text style={themed($optionText)}>{CAMERA_FOV_LABELS[fov]}</Text>
                {currentFov === fov && <Icon name="check" size={24} color={theme.colors.primary} />}
              </TouchableOpacity>
            )
          })}

          <Text style={[themed($settingSubtitle), {marginTop: theme.spacing.s4}]}>ROI position</Text>
          {([0, 1, 2] as const).map((roi, index, arr) => {
            const isFirst = index === 0
            const isLast = index === arr.length - 1
            return (
              <TouchableOpacity
                key={roi}
                style={[
                  themed($optionItem),
                  {
                    borderTopLeftRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
                    borderTopRightRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
                    borderBottomLeftRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
                    borderBottomRightRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
                    borderWidth: currentRoi === roi ? 1 : undefined,
                    borderColor: currentRoi === roi ? theme.colors.primary : undefined,
                  },
                ]}
                onPress={() => handleCameraFovChange(currentFov, roi)}>
                <Text style={themed($optionText)}>{CAMERA_ROI_LABELS[roi]}</Text>
                {currentRoi === roi && <Icon name="check" size={24} color={theme.colors.primary} />}
              </TouchableOpacity>
            )
          })}
        </View>
        {_devMode &&
        <View style={themed($settingsGroup)}>
          <ToggleSetting
            label={translate("settings:postProcessing")}
            subtitle={translate("settings:postProcessingSubtitle")}
            value={postProcessing}
            onValueChange={(v) => setPostProcessing(v)}
          />
        </View>
        }
      </ScrollView>
    </Screen>
  )
}

const $settingsGroup: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  paddingVertical: 14,
  paddingHorizontal: 16,
  borderRadius: spacing.s4,
  marginVertical: spacing.s3,
})

const $settingLabel: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 14,
  fontWeight: "600",
  marginBottom: spacing.s1,
})

const $settingSubtitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  color: colors.textDim,
  fontSize: 12,
  marginBottom: spacing.s3,
})

const $optionItem: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  padding: spacing.s4,
  backgroundColor: colors.background,
  marginBottom: spacing.s2,
})

const $optionText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 16,
})

const $emptyStateContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  paddingVertical: spacing.s12,
  minHeight: 300,
})

const $emptyStateText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 16,
  textAlign: "center",
})
