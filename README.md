# 🌿 Tiny Ecowitt Plant Monitor for Windows 🌿

Welcome to the **Tiny Ecowitt Plant Monitor**! 🎉 Wrote this with some help from ChatGPT in an afternoon because the web interface sucks and I'm on my computer all day anyways. Enjoy!

## 📋 Table of Contents

- [🔍 How to Find Your Gateway IP Address](#-how-to-find-your-gateway-ip-address)
- [💻 Download](#-download)
- [🛠️ How to Use](#️-how-to-use)
  - [1. Launch the App](#1-launch-the-app)
  - [2. Enter Your Gateway IP](#2-enter-your-gateway-ip)
  - [3. Assign and Name Your Sensors](#3-assign-and-name-your-sensors)
  - [4. Choose Your Theme](#4-choose-your-theme)
  - [5. Monitor Your Plant Environment](#5-monitor-your-plant-environment)
- [🎨 Themes](#-themes)
- [🔧 Troubleshooting](#-troubleshooting)

## 🔍 How to Find Your Gateway IP Address

Before you start monitoring your plants, you'll need to find the IP address of your Ecowitt Gateway. Here's a simple guide to help you locate it:

### **Step 1: Find the MAC Address Using the Ecowitt App**

1. **Open the Ecowitt App** on your iOS device (Might be the same on Android, I don't have one to test).
2. **Tap the Three-Line Icon** in the top left corner. 📱
3. **Select "My Devices"** from the menu.
4. **Tap the Three-Dot Icon** on the right side of your Ecowitt Gateway device.
5. **Write down/copy the MAC Address** displayed. 📋

### **Step 2: Locate the IP Address**

With the MAC address in hand, you can now find the corresponding IP address:

#### **Method 1: Check Your Router's Connected Devices**

1. **Access Your Router's Admin Page**:
   - Open a web browser.
   - Enter your router's IP address (commonly `192.168.1.1` or `192.168.0.1`) in the address bar.
   - Log in with your router's admin credentials.

2. **Navigate to the Connected Devices Section**:
   - Look for sections labeled **Connected Devices**, **Device List**, or **DHCP Clients**.

3. **Identify Your Ecowitt Gateway**:
   - Find the device matching the **MAC Address** you obtained.
   - Note the corresponding **IP Address** listed next to it.

#### **Method 2: Use Command Prompt (on Windows)**

1. **Open Command Prompt**:
   - Press `Win + R`, type `cmd`, and press `Enter`.

2. **Run the `arp` Command**:
   - Type the following command and press `Enter`:
     ```bash
     arp -a
     ```
   - This will display a list of IP addresses and their corresponding MAC addresses.

3. **Identify the Ecowitt Gateway**:
   - Look for the **MAC Address** you noted earlier.
   - Note the associated **IP Address**.

**NOTE:** Your computer and Ecowitt Gateway MUST be connected to the same network for the app to work.

## 💻 Download

Get started by downloading the .exe for Windows:

🔗 [Download Tiny Ecowitt Plant Monitor for Windows](https://github.com/orangesunshine321/Tiny-Ecowitt-Monitor/releases/download/1.0/ecowitt3.exe)

## 🛠️ How to Use

### 1. Launch the App

Double-click the `ecowitt3.exe` file to open the application. The main window will appear, displaying various sensor data fields related to your grow tent environment.

### 2. Enter Your Gateway IP

Upon first launch, you'll be prompted to enter your **Ecowitt Gateway IP Address**:

1. **Input the IP Address**:
   - Enter the IP address found earlier in the provided field (e.g., `192.168.1.100`).

2. **Save Settings**:
   - Click **Next** to proceed.

### 3. Assign and Name Your Sensors

Customize how your sensors are displayed to monitor your plant environment effectively:

1. **Assign Sensors**:
   - For each parameter (e.g., Temperature, Humidity, Soil Moisture), select the corresponding sensor number from the dropdown [Some sensors send values individually, some send as a group] or choose **Hide** to exclude it.

2. **Name Sensors**:
   - Put in names for each sensor to know which one is which. Easiest way is to look at the Ecowitt app during setup and match the values.

3. **Finish Setup**:
   - Click **Finish** to save your configurations.

### 4. Choose Your Theme

1. **Default Dark Mode** 🌓:
   - A standard dark interface that's easy on the eyes.

2. **Matrix Theme** 💚:
   - I like The Matrix so here you go.

   - Navigate to **Settings > Theme** to switch between themes anytime.

### 5. Monitor Your Plant Environment

View real-time updates to ensure your plants are thriving:

- **Sensor Panels**: Each assigned sensor displays its current value and status, such as temperature, humidity, soil moisture, and a VPD Calculator.
- **Automatic VPD Calculator**: Based on current Temps and Humidity from the sensors.
- **Soil Moisture**: Specialized section for monitoring soil conditions to prevent over or under-watering.
- **Last Updated**: Timestamp indicating the most recent data fetch to keep you informed about the latest readings.

## 🎨 Themes

### 🌓 Dark Mode

- A modern dark theme with dark grays and whites.

### 💚 Matrix Theme

- Inspired by the Matrix movie, featuring green monospaced text on a black background.

*You can switch themes anytime from the Settings menu.*

## 🔧 Troubleshooting

### ❗ App Doesn't Launch

💻 Windows Defender Popup for Unknown Developer
When you first run the Tiny Ecowitt Plant Monitor, Windows Defender may display a security warning indicating that the app is from an "Unknown Publisher." 

**To Bypass the Windows Defender Popup**

Double-click the ecowitt3.exe file to start the application.

You will see a popup from Windows Defender SmartScreen saying:
**Windows Defender SmartScreen
"Tiny Ecowitt Plant Monitor" is not recognized as an app from an identified publisher.**

Click on "More info":

After clicking "More info," a new Run anyway button will appear. Click this.

You might receive another prompt asking for confirmation. Click Yes to allow the app to run.

### Other

**Can't connect to Gateway**:
1. **Verify Gateway IP**:
   - Ensure the IP address entered is correct and the Ecowitt Gateway is powered on and connected to the network.

2. **Check Network Connection**:
   - Make sure your computer is connected to the same network as the Ecowitt Gateway.

3. **Try Below Steps**:
   - If the app fails to launch, try the steps below.

### ❗ Permission Denied on Windows

**Solutions**:
1. **Run as Administrator**:
   - Right-click the `Tiny-Ecowitt-Monitor.exe` and select **Run as administrator**.

2. **Check Antivirus Settings**:
   - Ensure your antivirus software isn't blocking the application.

If you experience other issues, let me know on the BuildaSoil Discord.
