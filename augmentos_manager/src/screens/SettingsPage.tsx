import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Switch,
  TouchableOpacity,
  Platform,
  ScrollView,
  Alert,
  Modal,
} from 'react-native';
import { Slider } from 'react-native-elements';
import Icon from 'react-native-vector-icons/FontAwesome';
import { useNavigation } from '@react-navigation/native';

import { useStatus } from '../AugmentOSStatusProvider';
import { BluetoothService } from '../BluetoothService';
import { loadSetting, saveSetting } from '../augmentos_core_comms/SettingsHelper';
import ManagerCoreCommsService from '../augmentos_core_comms/ManagerCoreCommsService';
import NavigationBar from '../components/NavigationBar';

import { SETTINGS_KEYS } from '../consts';
import { supabase } from '../supabaseClient';

import HeadUpAngleComponent from "../components/HeadUpAngleComponent.tsx";

interface SettingsPageProps {
  isDarkTheme: boolean;
  toggleTheme: () => void;
  navigation: any;
}

const parseBrightness = (brightnessStr: string | null | undefined): number => {
  if (!brightnessStr || brightnessStr.includes('-')) {
    return 50;
  }
  const parsed = parseInt(brightnessStr.replace('%', ''), 10);
  return isNaN(parsed) ? 50 : parsed;
};

const parseHeadUpAngle = (angle: number | null | undefined): number => {
    if (angle == null || angle < 0 || angle > 60) {
        return 20;
    }
    return isNaN(angle as number) ? 0 : angle as number;
};

const SettingsPage: React.FC<SettingsPageProps> = ({
  isDarkTheme,
  toggleTheme,
  navigation,
}) => {
  const { status } = useStatus();

  // -- Basic states from your original code --
  const [isDoNotDisturbEnabled, setDoNotDisturbEnabled] = useState(false);
  const [isBrightnessAutoEnabled, setBrightnessAutoEnabled] = useState(false);
  const [isSensingEnabled, setIsSensingEnabled] = useState(status.sensing_enabled);
  const [forceCoreOnboardMic, setForceCoreOnboardMic] = useState(
    status.force_core_onboard_mic
  );
  const [isContextualDashboardEnabled, setIsContextualDashboardEnabled] = useState(
    status.contextual_dashboard_enabled
  );
  const [brightness, setBrightness] = useState<number>(
    parseBrightness(status.glasses_info?.brightness)
  );

  // -- HEAD UP ANGLE STATES --
  const [headUpAngleComponentVisible, setHeadUpAngleComponentVisible] = useState(false);
 console.log('Sign-out successful' + status.glasses_info?.headUp_angle);
  const [headUpAngle, setHeadUpAngle] = useState<number>(
      parseHeadUpAngle(status.glasses_info?.headUp_angle)
  ); // default or loaded

  // -- Handlers for toggles, etc. --
  const toggleSensing = async () => {
    const newSensing = !isSensingEnabled;
    await BluetoothService.getInstance().sendToggleSensing(newSensing);
    setIsSensingEnabled(newSensing);
  };

  const toggleForceCoreOnboardMic = async () => {
    const newVal = !forceCoreOnboardMic;
    await BluetoothService.getInstance().sendToggleForceCoreOnboardMic(newVal);
    setForceCoreOnboardMic(newVal);
  };

  const toggleContextualDashboard = async () => {
    const newVal = !isContextualDashboardEnabled;
    await BluetoothService.getInstance().sendToggleContextualDashboard(newVal);
    setIsContextualDashboardEnabled(newVal);
  };

  const changeBrightness = async (newBrightness: number) => {
    if (status.glasses_info?.brightness === '-') return;
    await BluetoothService.getInstance().setGlassesBrightnessMode(newBrightness, false);
    setBrightness(newBrightness);
  };

  const onSaveHeadUpAngle = async (newHeadUpAngle: number) => {
    const newHeadUpAngleParsed = parseHeadUpAngle(newHeadUpAngle);
    setHeadUpAngleComponentVisible(false);
    await BluetoothService.getInstance().setGlassesHeadUpAngle(newHeadUpAngleParsed);
    setHeadUpAngle(newHeadUpAngleParsed);
  };

  const forgetGlasses = async () => {
    await BluetoothService.getInstance().sendForgetSmartGlasses();
  };

  const confirmForgetGlasses = () => {
    Alert.alert(
      'Forget Glasses',
      'Are you sure you want to forget your glasses?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Yes', onPress: forgetGlasses },
      ],
      { cancelable: false }
    );
  };

  const handleSignOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.error(error);
      // Handle sign-out error
    } else {
      console.log('Sign-out successful');
      ManagerCoreCommsService.stopService();
      BluetoothService.resetInstance();
      navigation.reset({
        index: 0,
        routes: [{ name: 'SplashScreen' }],
      });
    }
  };

  const confirmSignOut = () => {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Yes', onPress: handleSignOut },
      ],
      { cancelable: false }
    );
  };

  // -- HEADUP ANGLE MODAL CALLBACKS --
  const onCancelHeadUpAngle = () => {
    setHeadUpAngleComponentVisible(false);
  };

  // Switch track colors
  const switchColors = {
    trackColor: {
      false: isDarkTheme ? '#666666' : '#D1D1D6',
      true: '#2196F3',
    },
    thumbColor:
      Platform.OS === 'ios' ? undefined : isDarkTheme ? '#FFFFFF' : '#FFFFFF',
    ios_backgroundColor: isDarkTheme ? '#666666' : '#D1D1D6',
  };

  // Theming
  const theme = {
    backgroundColor: isDarkTheme ? '#1c1c1c' : '#f9f9f9',
    headerBg: isDarkTheme ? '#333333' : '#fff',
    textColor: isDarkTheme ? '#FFFFFF' : '#333333',
    subTextColor: isDarkTheme ? '#999999' : '#666666',
    cardBg: isDarkTheme ? '#333333' : '#fff',
    borderColor: isDarkTheme ? '#444444' : '#e0e0e0',
    searchBg: isDarkTheme ? '#2c2c2c' : '#f5f5f5',
    categoryChipBg: isDarkTheme ? '#444444' : '#e9e9e9',
    categoryChipText: isDarkTheme ? '#FFFFFF' : '#555555',
    selectedChipBg: isDarkTheme ? '#666666' : '#333333',
    selectedChipText: isDarkTheme ? '#FFFFFF' : '#FFFFFF',
  };

  // Condition to disable HeadUp Angle setting
  const disableHeadUpAngle =
    !status.glasses_info?.model_name ||
    status.glasses_info?.brightness === '-' ||
    !status.glasses_info.model_name.toLowerCase().includes('even');

  return (
    <View
      style={[
        styles.container,
        isDarkTheme ? styles.darkBackground : styles.lightBackground,
      ]}
    >
      {/* Title Section */}
      <View
        style={[
          styles.titleContainer,
          isDarkTheme ? styles.titleContainerDark : styles.titleContainerLight,
        ]}
      >
        <Text
          style={[
            styles.title,
            isDarkTheme ? styles.lightText : styles.darkText,
          ]}
        >
          Settings
        </Text>
      </View>

      <ScrollView style={styles.scrollViewContainer}>
        {/* Force Onboard Microphone */}
        <View style={styles.settingItem}>
          <View style={styles.settingTextContainer}>
            <Text
              style={[
                styles.label,
                isDarkTheme ? styles.lightText : styles.darkText,
                (!status.puck_connected || !status.glasses_info?.model_name) &&
                  styles.disabledItem,
              ]}
            >
              Force Onboard Microphone
            </Text>
            <Text
              style={[
                styles.value,
                isDarkTheme ? styles.lightSubtext : styles.darkSubtext,
                (!status.puck_connected || !status.glasses_info?.model_name) &&
                  styles.disabledItem,
              ]}
            >
              Force the use of the onboard mic instead of the glasses' mic (if applicable).
            </Text>
          </View>
          <Switch
            disabled={!status.glasses_info?.model_name}
            value={forceCoreOnboardMic}
            onValueChange={toggleForceCoreOnboardMic}
            trackColor={switchColors.trackColor}
            thumbColor={switchColors.thumbColor}
            ios_backgroundColor={switchColors.ios_backgroundColor}
          />
        </View>

        {/* Privacy Settings */}
        <TouchableOpacity
          style={styles.settingItem}
          onPress={() => {
            navigation.navigate('PrivacySettingsScreen');
          }}
        >
          <View style={styles.settingTextContainer}>
            <Text
              style={[
                styles.label,
                isDarkTheme ? styles.lightText : styles.darkText,
              ]}
            >
              Privacy Settings
            </Text>
          </View>
          <Icon
            name="angle-right"
            size={20}
            color={isDarkTheme ? styles.lightIcon.color : styles.darkIcon.color}
          />
        </TouchableOpacity>

        {/* Contextual Dashboard */}
        <View style={styles.settingItem}>
          <View style={styles.settingTextContainer}>
            <Text
              style={[
                styles.label,
                isDarkTheme ? styles.lightText : styles.darkText,
                (!status.puck_connected || !status.glasses_info?.model_name) &&
                  styles.disabledItem,
              ]}
            >
              Contextual Dashboard
            </Text>
            {status.glasses_info?.model_name && (
              <Text
                style={[
                  styles.value,
                  isDarkTheme ? styles.lightSubtext : styles.darkSubtext,
                  (!status.puck_connected || !status.glasses_info?.model_name) &&
                    styles.disabledItem,
                ]}
              >
                {`Show a summary of your phone notifications when you ${
                  status.glasses_info?.model_name
                    .toLowerCase()
                    .includes('even')
                    ? 'look up'
                    : 'tap your smart glasses'
                }.`}
              </Text>
            )}
          </View>
          <Switch
            disabled={!status.glasses_info?.model_name}
            value={isContextualDashboardEnabled}
            onValueChange={toggleContextualDashboard}
            trackColor={switchColors.trackColor}
            thumbColor={switchColors.thumbColor}
            ios_backgroundColor={switchColors.ios_backgroundColor}
          />
        </View>

        {/* Brightness Slider */}
        <View style={styles.settingItem}>
          <View style={styles.settingTextContainer}>
            <Text
              style={[
                styles.label,
                isDarkTheme ? styles.lightText : styles.darkText,
                (!status.puck_connected || !status.glasses_info?.model_name) &&
                  styles.disabledItem,
              ]}
            >
              Brightness
            </Text>
            <Text
              style={[
                styles.value,
                isDarkTheme ? styles.lightSubtext : styles.darkSubtext,
                (!status.puck_connected || !status.glasses_info?.model_name) &&
                  styles.disabledItem,
              ]}
            >
              Adjust the brightness level of your smart glasses.
            </Text>
            <Slider
              disabled={
                !status.glasses_info?.model_name ||
                status.glasses_info?.brightness === '-' ||
                !status.glasses_info.model_name.toLowerCase().includes('even')
              }
              style={styles.slider}
              minimumValue={0}
              maximumValue={100}
              thumbTouchSize={styles.thumbTouchSize}
              trackStyle={styles.trackStyle}
              thumbStyle={styles.thumbStyle}
              step={1}
              onSlidingComplete={(value) => changeBrightness(value)}
              value={brightness}
              minimumTrackTintColor={styles.minimumTrackTintColor.color}
              maximumTrackTintColor={
                isDarkTheme
                  ? styles.maximumTrackTintColorDark.color
                  : styles.maximumTrackTintColorLight.color
              }
              thumbTintColor={styles.thumbTintColor.color}
            />
          </View>
        </View>

        {/* HEADUP ANGLE SETTING (Button that opens the modal) */}
        <TouchableOpacity
          style={[
            styles.settingItem,
            disableHeadUpAngle && styles.disabledItem,
          ]}
          disabled={disableHeadUpAngle}
          onPress={() => setHeadUpAngleComponentVisible(true)}
        >
          <View style={styles.settingTextContainer}>
            <Text
              style={[
                styles.label,
                isDarkTheme ? styles.lightText : styles.darkText,
              ]}
            >
              HeadUp Angle
            </Text>
            <Text
              style={[
                styles.value,
                isDarkTheme ? styles.lightSubtext : styles.darkSubtext,
              ]}
            >
              Adjust the display angle for your HeadUp.
            </Text>
          </View>
          <Icon
            name="angle-right"
            size={20}
            color={isDarkTheme ? styles.lightIcon.color : styles.darkIcon.color}
          />
        </TouchableOpacity>

        {/* Forget Glasses */}
        <TouchableOpacity
          style={styles.settingItem}
          disabled={!status.puck_connected || status.default_wearable === ''}
          onPress={confirmForgetGlasses}
        >
          <View style={styles.settingTextContainer}>
            <Text
              style={[
                styles.label,
                styles.redText,
                (!status.puck_connected || status.default_wearable === '') &&
                  styles.disabledItem,
              ]}
            >
              Forget Glasses
            </Text>
          </View>
        </TouchableOpacity>

        {/* Sign Out */}
        <TouchableOpacity style={styles.settingItem} onPress={confirmSignOut}>
          <View style={styles.settingTextContainer}>
            <Text style={[styles.label, styles.redText]}>Sign Out</Text>
          </View>
        </TouchableOpacity>
      </ScrollView>

      {/* HEADUP ANGLE MODAL (the semicircle one) */}
      <HeadUpAngleComponent
        visible={headUpAngleComponentVisible}
        initialAngle={headUpAngle}
        onCancel={onCancelHeadUpAngle}
        onSave={onSaveHeadUpAngle}
      />

      {/* Your app’s bottom navigation bar */}
      <NavigationBar toggleTheme={toggleTheme} isDarkTheme={isDarkTheme} />
    </View>
  );
};

export default SettingsPage;

const styles = StyleSheet.create({
  scrollViewContainer: {
    marginBottom: 55,
  },
  container: {
    flex: 1,
    padding: 20,
  },
  titleContainer: {
    paddingVertical: 15,
    paddingHorizontal: 20,
    marginHorizontal: -20,
    marginTop: -20,
    marginBottom: 10,
  },
  titleContainerDark: {
    backgroundColor: '#333333',
  },
  titleContainerLight: {
    backgroundColor: '#ffffff',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    fontFamily: 'Montserrat-Bold',
    textAlign: 'left',
    color: '#FFFFFF',
    marginBottom: 5,
  },
  darkBackground: {
    backgroundColor: '#1c1c1c',
  },
  lightBackground: {
    backgroundColor: '#f0f0f0',
  },
  redText: {
    color: '#FF0F0F',
  },
  darkText: {
    color: 'black',
  },
  lightText: {
    color: 'white',
  },
  darkSubtext: {
    color: '#666666',
  },
  lightSubtext: {
    color: '#999999',
  },
  darkIcon: {
    color: '#333333',
  },
  lightIcon: {
    color: '#666666',
  },
  settingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 20,
    borderBottomColor: '#333',
    borderBottomWidth: 1,
  },
  settingTextContainer: {
    flex: 1,
    paddingRight: 10,
  },
  label: {
    fontSize: 16,
    flexWrap: 'wrap',
  },
  value: {
    fontSize: 12,
    marginTop: 5,
    flexWrap: 'wrap',
  },
  disabledItem: {
    opacity: 0.4,
  },
  slider: {
    width: '100%',
    height: 40,
  },
  thumbTouchSize: {
    width: 40,
    height: 40,
  },
  trackStyle: {
    height: 5,
  },
  thumbStyle: {
    height: 20,
    width: 20,
  },
  minimumTrackTintColor: {
    color: '#2196F3',
  },
  maximumTrackTintColorDark: {
    color: '#666666',
  },
  maximumTrackTintColorLight: {
    color: '#D1D1D6',
  },
  thumbTintColor: {
    color: '#FFFFFF',
  },
});
