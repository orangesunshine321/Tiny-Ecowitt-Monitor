import requests
import time
import sys
import math
import threading
import tkinter as tk
from tkinter import ttk, simpledialog, messagebox
import json
import os

# Mapping of sensor IDs (0x01 to 0x19) to their parameters and types
ID_MAP_INT = {
    '0x01': {"param": "Indoor Temperature", "type": "temp"},
    '0x02': {"param": "Outdoor Temperature", "type": "temp"},
    '0x03': {"param": "Dew Point", "type": "dewpoint"},
    '0x04': {"param": "Wind Chill", "type": "windchill"},
    '0x05': {"param": "Heat Index", "type": "heatindex"},
    '0x06': {"param": "Indoor Humidity", "type": "humidity"},
    '0x07': {"param": "Outdoor Humidity", "type": "humidity"},
    '0x08': {"param": "Absolute Barometric", "type": "pressure"},
    '0x09': {"param": "Relative Barometric", "type": "pressure"},
    '0x0A': {"param": "Wind Direction", "type": "winddir"},
    '0x0B': {"param": "Wind Speed", "type": "windspeed"},
    '0x0C': {"param": "Gust Speed", "type": "gustspeed"},
    '0x0D': {"param": "Rain Event", "type": "rain"},
    '0x0E': {"param": "Rain Rate", "type": "rainrate"},
    '0x0F': {"param": "Rain Hour", "type": "rain"},
    '0x10': {"param": "Rain Day", "type": "rain"},
    '0x11': {"param": "Rain Week", "type": "rain"},
    '0x12': {"param": "Rain Month", "type": "rain"},
    '0x13': {"param": "Rain Year", "type": "rain"},
    '0x14': {"param": "Rain Total", "type": "rain"},
    '0x15': {"param": "Light", "type": "light"},
    '0x16': {"param": "UV", "type": "uv"},
    '0x17': {"param": "UVI", "type": "uvi"},
    '0x18': {"param": "Date and Time", "type": "datetime"},
    '0x19': {"param": "Day Max Wind", "type": "windspeed"},
    # Include IDs without '0x' prefix if they exist in the data
    '1': {"param": "Indoor Temperature", "type": "temp"},
    '2': {"param": "Outdoor Temperature", "type": "temp"},
    '3': {"param": "Dew Point", "type": "dewpoint"},
    '4': {"param": "Wind Chill", "type": "windchill"},
    '5': {"param": "Heat Index", "type": "heatindex"},
    '6': {"param": "Indoor Humidity", "type": "humidity"},
    '7': {"param": "Outdoor Humidity", "type": "humidity"},
    # Add other IDs as needed
}

CONFIG_FILE = "ecowitt_config.json"

def get_live_data(gateway_ip):
    url = f'http://{gateway_ip}/get_livedata_info'
    try:
        response = requests.get(url, timeout=5)
        response.raise_for_status()
        data = response.json()
        return data
    except requests.RequestException as e:
        return {'error': str(e)}

def fahrenheit_to_celsius(f):
    return (f - 32) * 5.0 / 9.0

def celsius_to_fahrenheit(c):
    return c * 9.0 / 5.0 + 32

def calculate_vpd(temp_c, rh):
    es = 0.6108 * math.exp((17.27 * temp_c) / (temp_c + 237.3))
    ea = es * (rh / 100.0)
    vpd = es - ea
    return vpd

class EcowittApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Ecowitt Live Data Monitor")
        self.config = {}
        self.sensors = {}
        self.gateway_ip = ''
        self.soil_tree = None  # Initialize soil_tree to None
        self.theme = tk.StringVar(value="dark")  # Default theme is dark

        self.load_config()
        self.create_widgets()

        # Run setup wizard only if settings are missing
        if not self.gateway_ip or not self.sensors:
            self.setup_wizard()
        else:
            self.build_sensor_frames()
            self.update_data()

    def load_config(self):
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, 'r') as f:
                self.config = json.load(f)
                self.gateway_ip = self.config.get('gateway_ip', '')
                self.sensors = self.config.get('sensors', {})
                self.theme.set(self.config.get('theme', 'dark'))
        else:
            self.config = {}

    def save_config(self):
        self.config['gateway_ip'] = self.gateway_ip
        self.config['sensors'] = self.sensors
        self.config['theme'] = self.theme.get()
        with open(CONFIG_FILE, 'w') as f:
            json.dump(self.config, f, indent=4)

    def create_widgets(self):
        self.style = ttk.Style()
        self.apply_theme()

        self.main_frame = ttk.Frame(self.root, padding="10")
        self.main_frame.pack(fill=tk.BOTH, expand=True)

        # Menu
        self.create_menu()

        # Title
        self.title_label = ttk.Label(self.main_frame, text="Ecowitt Live Data Monitor", font=("Helvetica", 18, "bold"))
        self.title_label.pack(pady=10)

        # Settings Button
        self.settings_button = ttk.Button(self.main_frame, text="Change Settings", command=self.setup_wizard)
        self.settings_button.pack(pady=5)

        # Footer
        self.footer_label = ttk.Label(self.main_frame, text="")
        self.footer_label.pack(pady=5)

    def create_menu(self):
        menu_bar = tk.Menu(self.root)
        self.root.config(menu=menu_bar)

        # Settings menu
        settings_menu = tk.Menu(menu_bar, tearoff=0)
        settings_menu.add_command(label="Setup Wizard", command=self.setup_wizard)

        # Theme submenu
        theme_menu = tk.Menu(settings_menu, tearoff=0)
        theme_menu.add_radiobutton(label="Dark Mode", variable=self.theme, value="dark", command=self.apply_theme)
        theme_menu.add_radiobutton(label="Matrix Theme", variable=self.theme, value="matrix", command=self.apply_theme)
        settings_menu.add_cascade(label="Theme", menu=theme_menu)

        settings_menu.add_separator()
        settings_menu.add_command(label="Exit", command=self.root.quit)
        menu_bar.add_cascade(label="Settings", menu=settings_menu)

    def apply_theme(self):
        selected_theme = self.theme.get()
        if selected_theme == "matrix":
            # Matrix theme colors
            bg_color = '#000000'  # Black background
            fg_color = '#00FF00'  # Green text
            font_family = 'Consolas'  # Monospaced font
            font_size = 11
        else:
            # Default dark theme
            bg_color = '#2E2E2E'  # Dark gray background
            fg_color = '#FFFFFF'  # White text
            font_family = 'Helvetica'
            font_size = 11

        # Configure styles
        self.style.theme_use('clam')
        self.style.configure('.', background=bg_color, foreground=fg_color, fieldbackground=bg_color, font=(font_family, font_size))
        self.style.configure('TLabel', background=bg_color, foreground=fg_color, font=(font_family, font_size))
        self.style.configure('TButton', background=bg_color, foreground=fg_color, font=(font_family, font_size))
        self.style.configure('TEntry', background=bg_color, foreground=fg_color, fieldbackground=bg_color, font=(font_family, font_size))
        self.style.configure('TMenubutton', background=bg_color, foreground=fg_color, font=(font_family, font_size))
        self.style.configure('TNotebook', background=bg_color, foreground=fg_color, font=(font_family, font_size))
        self.style.configure('TFrame', background=bg_color, foreground=fg_color)
        self.style.configure('TCheckbutton', background=bg_color, foreground=fg_color, font=(font_family, font_size))

        # Treeview style
        self.style.configure('Treeview', background=bg_color, foreground=fg_color, fieldbackground=bg_color, bordercolor=bg_color, borderwidth=0, font=(font_family, font_size))
        self.style.map('Treeview', background=[('selected', '#4E4E4E')], foreground=[('selected', fg_color)])
        self.style.configure('Treeview.Heading', background=bg_color, foreground=fg_color, font=(font_family, font_size, 'bold'))
        self.style.map('Treeview.Heading', background=[('active', '#3E3E3E')], foreground=[('active', fg_color)])

        # Update existing widgets
        self.update_widget_styles(self.root)

        # Save the selected theme
        self.save_config()

    def update_widget_styles(self, widget):
        for child in widget.winfo_children():
            wtype = child.winfo_class()
            if wtype == 'Frame' or wtype == 'TFrame':
                child.configure(style='TFrame')
                self.update_widget_styles(child)
            elif wtype == 'Label' or wtype == 'TLabel':
                child.configure(style='TLabel')
            elif wtype == 'Button' or wtype == 'TButton':
                child.configure(style='TButton')
            elif wtype == 'Entry' or wtype == 'TEntry':
                child.configure(style='TEntry')
            elif wtype == 'Menubutton' or wtype == 'TMenubutton':
                child.configure(style='TMenubutton')
            elif wtype == 'Checkbutton' or wtype == 'TCheckbutton':
                child.configure(style='TCheckbutton')
            elif wtype == 'Treeview':
                child.configure(style='Treeview')
            elif wtype == 'Labelframe' or wtype == 'TLabelframe':
                child.configure(style='TFrame')
                self.update_widget_styles(child)
            else:
                self.update_widget_styles(child)  # Recursive call to catch all widgets

    def setup_wizard(self):
        # Step 1: Get Gateway IP
        self.gateway_ip = simpledialog.askstring("Gateway IP", "Enter your Ecowitt Gateway IP Address:", initialvalue=self.gateway_ip)
        if not self.gateway_ip:
            messagebox.showerror("Error", "Gateway IP is required.")
            return

        # Step 2: Scan for Sensors
        data = get_live_data(self.gateway_ip)
        if 'error' in data:
            messagebox.showerror("Error", f"Error retrieving data: {data['error']}")
            return

        # Collect all sensor readings
        sensor_readings = self.collect_sensor_readings(data)

        # Present the readings in a table with dropdowns to assign sensors
        self.assign_sensors(sensor_readings)

    def normalize_id(self, id_str):
        """Normalize the ID to a consistent format."""
        if id_str.startswith('0x') or id_str.startswith('0X'):
            return id_str.lower()
        else:
            # Convert decimal ID to hex with '0x' prefix
            try:
                id_int = int(id_str)
                return f"0x{id_int:02x}"
            except ValueError:
                return id_str.lower()

    def collect_sensor_readings(self, data):
        sensor_readings = []

        # Process 'common_list' sensors
        common_list = data.get('common_list', [])
        for item in common_list:
            if isinstance(item, dict):
                id_str = item.get('id')
                val = item.get('val')
                unit = item.get('unit', '')
                label = item.get('label', '')
                if id_str and val:
                    normalized_id = self.normalize_id(id_str)
                    mapping = ID_MAP_INT.get(normalized_id)
                    if mapping:
                        param = mapping['param']
                        sensor_type = mapping['type']
                        val_str = val.replace(unit, '').replace('%', '').strip()
                        try:
                            val_float = float(val_str)
                            sensor_readings.append({
                                'param': param,
                                'type': sensor_type,
                                'value': val_float,
                                'unit': unit.strip(),
                                'original_val': val.strip(),  # Store original value with units
                                'id': normalized_id,
                                'label': label
                            })
                        except ValueError:
                            pass

        # Process 'wh25' for indoor sensors
        wh25_list = data.get('wh25', [])
        for wh25 in wh25_list:
            if isinstance(wh25, dict):
                temp_str = wh25.get('intemp')
                temp_unit = wh25.get('unit', '')
                humidity_str = wh25.get('inhumi')
                if temp_str:
                    temp_str_clean = temp_str.strip()
                    try:
                        temp_f = float(temp_str_clean)
                        sensor_readings.append({
                            'param': 'Indoor Temperature',
                            'type': 'temp',
                            'value': temp_f,
                            'unit': temp_unit.strip(),
                            'original_val': temp_str_clean,
                            'id': 'wh25_intemp',
                            'label': 'Indoor Temp'
                        })
                    except ValueError:
                        pass
                if humidity_str:
                    humidity_str_clean = humidity_str.strip()
                    try:
                        humidity = float(humidity_str_clean.replace('%', '').strip())
                        sensor_readings.append({
                            'param': 'Indoor Humidity',
                            'type': 'humidity',
                            'value': humidity,
                            'unit': '%',
                            'original_val': humidity_str_clean,
                            'id': 'wh25_inhumi',
                            'label': 'Indoor Humidity'
                        })
                    except ValueError:
                        pass

        # Process 'ch_soil' for soil moisture sensors
        ch_soil = data.get('ch_soil', [])
        for item in ch_soil:
            if isinstance(item, dict):
                channel = item.get('channel')
                humidity = item.get('humidity')
                battery = item.get('battery')
                if humidity and channel:
                    humidity_str_clean = humidity.replace('%', '').strip()
                    try:
                        humidity_value = float(humidity_str_clean)
                        sensor_readings.append({
                            'param': f"Soil Moisture (Channel {channel})",
                            'type': f"soil_moisture_{channel}",
                            'value': humidity_value,
                            'unit': '%',
                            'original_val': humidity.strip(),
                            'id': f"soil_ch{channel}",
                            'label': f"Soil Moisture Channel {channel}",
                            'battery': battery
                        })
                    except ValueError:
                        pass

        return sensor_readings

    def assign_sensors(self, sensor_readings):
        # Create a new window for sensor assignment
        assign_window = tk.Toplevel(self.root)
        assign_window.title("Assign Sensors")

        # Apply theme to the assignment window
        self.update_widget_styles(assign_window)

        ttk.Label(assign_window, text="Assign each input to a sensor number or hide it.").grid(row=0, column=0, columnspan=3, pady=10)

        # Table headers
        ttk.Label(assign_window, text="Parameter").grid(row=1, column=0, padx=5)
        ttk.Label(assign_window, text="Value").grid(row=1, column=1, padx=5)
        ttk.Label(assign_window, text="Sensor #").grid(row=1, column=2, padx=5)

        # Keep track of the sensor assignments
        assignments = []

        # Determine the maximum number of sensors (increase if necessary)
        max_sensors = 10

        # Create dropdown options for sensor numbers
        sensor_numbers = ['Hide'] + [str(i+1) for i in range(max_sensors)]

        for idx, reading in enumerate(sensor_readings):
            label_text = f"{reading['param']} (ID: {reading['id']})"
            if reading.get('label'):
                label_text += f" - {reading['label']}"
            ttk.Label(assign_window, text=label_text).grid(row=idx+2, column=0, padx=5, sticky=tk.W)
            ttk.Label(assign_window, text=f"{reading['original_val']} {reading['unit']}").grid(row=idx+2, column=1, padx=5)
            sensor_var = tk.StringVar(value='Hide')
            sensor_menu = ttk.OptionMenu(assign_window, sensor_var, sensor_var.get(), *sensor_numbers)
            sensor_menu.grid(row=idx+2, column=2, padx=5)
            assignments.append({'reading': reading, 'sensor_var': sensor_var})

        # Apply theme to widgets in the assignment window
        self.update_widget_styles(assign_window)

        # Button to confirm assignments
        def confirm_assignments():
            # Build sensors based on assignments
            sensor_dict = {}
            sensor_assignments = {}  # New dict to store readings assigned to each sensor number
            self.soil_sensors = []  # List to hold soil moisture sensors
            for assignment in assignments:
                sensor_num = assignment['sensor_var'].get()
                reading = assignment['reading']
                if sensor_num != 'Hide':
                    if 'soil_moisture' in reading['type']:
                        # Collect soil moisture sensors separately
                        self.soil_sensors.append({
                            'channel': reading['type'].split('_')[-1],
                            'id': reading['id'],
                            'battery': reading.get('battery', 'N/A'),
                            'label': reading['label']
                        })
                    else:
                        if sensor_num not in sensor_dict:
                            sensor_dict[sensor_num] = {}
                            sensor_assignments[sensor_num] = []
                        sensor_dict[sensor_num][reading['type']] = reading['id']
                        sensor_assignments[sensor_num].append(reading)
                else:
                    # Hidden readings are not processed
                    continue

            # Proceed to sensor naming window
            self.sensor_dict = sensor_dict  # Store for access in naming window
            self.sensor_assignments = sensor_assignments  # Store assignments for naming window
            assign_window.destroy()
            self.sensor_naming_window()

        ttk.Button(assign_window, text="Next", command=confirm_assignments).grid(row=len(sensor_readings)+2, column=0, columnspan=3, pady=10)

    def sensor_naming_window(self):
        # Create a new window for sensor naming
        naming_window = tk.Toplevel(self.root)
        naming_window.title("Name Sensors")

        # Apply theme to the naming window
        self.update_widget_styles(naming_window)

        ttk.Label(naming_window, text="Enter names for each sensor:").grid(row=0, column=0, columnspan=2, pady=10)

        self.sensor_names_vars = {}

        for idx, sensor_num in enumerate(sorted(self.sensor_dict.keys(), key=lambda x: int(x))):
            base_row = idx * 3 + 1
            sensor_label = ttk.Label(naming_window, text=f"Sensor #{sensor_num}:")
            sensor_label.grid(row=base_row, column=0, padx=5, pady=5, sticky=tk.E)
            sensor_name_var = tk.StringVar(value=f"Sensor_{sensor_num}")
            sensor_entry = ttk.Entry(naming_window, textvariable=sensor_name_var)
            sensor_entry.grid(row=base_row, column=1, padx=5, pady=5, sticky=tk.W)
            self.sensor_names_vars[sensor_num] = sensor_name_var

            # Display assigned inputs
            assigned_readings = self.sensor_assignments.get(sensor_num, [])
            assigned_params = [f"{reading['param']} ({reading['type']})" for reading in assigned_readings]
            assigned_text = ', '.join(assigned_params)
            ttk.Label(naming_window, text=f"Assigned inputs:").grid(row=base_row+1, column=0, padx=5, sticky=tk.E)
            ttk.Label(naming_window, text=assigned_text).grid(row=base_row+1, column=1, padx=5, sticky=tk.W)

        # Apply theme to widgets in the naming window
        self.update_widget_styles(naming_window)

        def confirm_names():
            # Save sensor names
            self.sensors = {}
            for sensor_num, name_var in self.sensor_names_vars.items():
                sensor_name = name_var.get()
                if sensor_name:
                    self.sensors[sensor_name] = self.sensor_dict[sensor_num]
                else:
                    self.sensors[f"Sensor_{sensor_num}"] = self.sensor_dict[sensor_num]
            # Save configuration
            self.save_config()
            # Rebuild UI with new sensors
            self.build_sensor_frames()
            # Start data updating
            self.update_data()
            # Close the naming window
            naming_window.destroy()

        ttk.Button(naming_window, text="Finish", command=confirm_names).grid(row=base_row+2, column=0, columnspan=2, pady=10)

    def build_sensor_frames(self):
        # Remove existing frames if any
        for widget in self.main_frame.winfo_children():
            if isinstance(widget, ttk.LabelFrame) or isinstance(widget, ttk.Treeview):
                widget.destroy()

        # Build frames for each sensor
        self.sensor_frames = {}
        for sensor_name, sensor_data in self.sensors.items():
            frame = ttk.LabelFrame(self.main_frame, text=sensor_name, padding="10")
            frame.pack(fill=tk.X, expand=True, pady=5)
            self.sensor_frames[sensor_name] = frame

            # Data labels and variables
            row = 0
            frame.vars = {}
            for sensor_type in sensor_data.keys():
                if sensor_type == 'temp':
                    label = ttk.Label(frame, text="Temperature (°F):")
                    var = tk.StringVar()
                elif sensor_type == 'humidity':
                    label = ttk.Label(frame, text="Humidity (%):")
                    var = tk.StringVar()
                elif sensor_type == 'pressure':
                    label = ttk.Label(frame, text="Pressure (hPa):")
                    var = tk.StringVar()
                elif sensor_type == 'windspeed':
                    label = ttk.Label(frame, text="Wind Speed (m/s):")
                    var = tk.StringVar()
                elif sensor_type == 'winddir':
                    label = ttk.Label(frame, text="Wind Direction (°):")
                    var = tk.StringVar()
                elif sensor_type == 'rain':
                    label = ttk.Label(frame, text="Rainfall (mm):")
                    var = tk.StringVar()
                else:
                    continue  # Skip unknown types
                label.grid(row=row, column=0, sticky=tk.W, padx=5, pady=2)
                ttk.Label(frame, textvariable=var).grid(row=row, column=1, sticky=tk.E, padx=5, pady=2)
                frame.vars[sensor_type] = var
                row += 1

            # VPD is calculated if temp and humidity are present
            if 'temp' in sensor_data and 'humidity' in sensor_data:
                label = ttk.Label(frame, text="VPD (kPa):")
                var = tk.StringVar()
                label.grid(row=row, column=0, sticky=tk.W, padx=5, pady=2)
                ttk.Label(frame, textvariable=var).grid(row=row, column=1, sticky=tk.E, padx=5, pady=2)
                frame.vars['vpd'] = var
                row += 1

            # Apply theme to sensor frame
            self.update_widget_styles(frame)

        # Soil moisture sensors
        if hasattr(self, 'soil_sensors') and self.soil_sensors:
            self.soil_frame = ttk.LabelFrame(self.main_frame, text="Soil Moisture Sensors", padding="10")
            self.soil_frame.pack(fill=tk.X, expand=True, pady=5)
            self.soil_tree = ttk.Treeview(self.soil_frame, columns=("Sensor", "Moisture (%)", "Battery"), show="headings")
            self.soil_tree.heading("Sensor", text="Sensor")
            self.soil_tree.heading("Moisture (%)", text="Moisture (%)")
            self.soil_tree.heading("Battery", text="Battery")
            self.soil_tree.pack(fill=tk.X, expand=True)
            # Apply theme to soil frame
            self.update_widget_styles(self.soil_frame)
        else:
            self.soil_tree = None  # Ensure soil_tree is None if no soil sensors

        # Move footer label to the end
        self.footer_label.pack_forget()
        self.footer_label.pack(pady=5)

    def update_data(self):
        data = get_live_data(self.gateway_ip)
        if 'error' in data:
            self.footer_label.config(text=f"Error retrieving data: {data['error']}")
        else:
            # Collect sensor values
            sensor_values = {}
            common_list = data.get('common_list', [])
            for item in common_list:
                if isinstance(item, dict):
                    id_str = item.get('id')
                    val = item.get('val')
                    unit = item.get('unit', '')
                    if id_str and val:
                        normalized_id = self.normalize_id(id_str)
                        mapping = ID_MAP_INT.get(normalized_id)
                        if mapping:
                            val_str = val.replace(unit, '').replace('%', '').strip()
                            try:
                                val_float = float(val_str)
                                sensor_values[normalized_id] = val_float
                            except ValueError:
                                pass

            # Process 'wh25' for indoor sensors
            wh25_list = data.get('wh25', [])
            for wh25 in wh25_list:
                if isinstance(wh25, dict):
                    temp_str = wh25.get('intemp')
                    temp_unit = wh25.get('unit', '')
                    humidity_str = wh25.get('inhumi')
                    if temp_str:
                        temp_str_clean = temp_str.strip()
                        try:
                            temp_f = float(temp_str_clean)
                            sensor_values['wh25_intemp'] = temp_f
                        except ValueError:
                            pass
                    if humidity_str:
                        humidity_str_clean = humidity_str.strip()
                        try:
                            humidity = float(humidity_str_clean.replace('%', '').strip())
                            sensor_values['wh25_inhumi'] = humidity
                        except ValueError:
                            pass

            # Process soil moisture sensors
            soil_moisture_values = {}
            ch_soil = data.get('ch_soil', [])
            for item in ch_soil:
                if isinstance(item, dict):
                    channel = item.get('channel')
                    humidity = item.get('humidity')
                    battery = item.get('battery')
                    if humidity and channel:
                        humidity_str_clean = humidity.replace('%', '').strip()
                        try:
                            humidity_value = float(humidity_str_clean)
                            soil_moisture_values[f"soil_ch{channel}"] = {
                                'moisture': humidity_value,
                                'battery': battery
                            }
                        except ValueError:
                            pass

            # Update the data for sensors
            for sensor_name, ids in self.sensors.items():
                frame = self.sensor_frames.get(sensor_name)
                if not frame:
                    continue  # Skip if frame doesn't exist (shouldn't happen)

                values = {}
                for sensor_type, sensor_id in ids.items():
                    value = sensor_values.get(sensor_id)
                    if value is not None:
                        values[sensor_type] = value

                # Update displayed values
                for sensor_type, var in frame.vars.items():
                    if sensor_type in values:
                        if sensor_type == 'temp':
                            var.set(f"{values[sensor_type]:.2f} °F")
                        elif sensor_type == 'humidity':
                            var.set(f"{values[sensor_type]:.2f} %")
                        elif sensor_type == 'pressure':
                            var.set(f"{values[sensor_type]:.2f} hPa")
                        elif sensor_type == 'windspeed':
                            var.set(f"{values[sensor_type]:.2f} m/s")
                        elif sensor_type == 'winddir':
                            var.set(f"{values[sensor_type]:.2f} °")
                        elif sensor_type == 'rain':
                            var.set(f"{values[sensor_type]:.2f} mm")
                    else:
                        var.set("N/A")

                # Calculate VPD if temp and humidity are present
                if 'temp' in values and 'humidity' in values and 'vpd' in frame.vars:
                    temp_f = values['temp']
                    humidity = values['humidity']
                    temp_c = fahrenheit_to_celsius(temp_f)
                    vpd = calculate_vpd(temp_c, humidity)
                    frame.vars['vpd'].set(f"{vpd:.3f} kPa")
                elif 'vpd' in frame.vars:
                    frame.vars['vpd'].set("N/A")

            # Update soil moisture sensors
            if self.soil_tree:
                # Clear existing entries
                for item in self.soil_tree.get_children():
                    self.soil_tree.delete(item)
                for soil_sensor in self.soil_sensors:
                    sensor_id = soil_sensor['id']
                    channel = soil_sensor['channel']
                    label = soil_sensor.get('label', f"Soil Moisture Channel {channel}")
                    data = soil_moisture_values.get(sensor_id)
                    if data:
                        moisture = f"{data['moisture']:.2f}"
                        battery_status = 'Normal' if int(data['battery']) > 1 else 'Low'
                    else:
                        moisture = "N/A"
                        battery_status = "N/A"
                    self.soil_tree.insert("", tk.END, values=(label, moisture, battery_status))

            # Update footer with timestamp
            self.footer_label.config(text="Last updated: " + time.strftime('%Y-%m-%d %H:%M:%S'))

        # Schedule next update
        self.root.after(1000, self.update_data)  # Update every 1000ms

if __name__ == '__main__':
    root = tk.Tk()
    app = EcowittApp(root)
    root.mainloop()
