# TropiSCO Forest Loss Explorer

A TropiSCO-inspired forest loss monitoring application built in Google Earth Engine (GEE) using Sentinel-1 Synthetic Aperture Radar (SAR) imagery and ESA WorldCover data.

The application provides an interactive interface for monitoring annual and monthly forest loss dynamics across user-defined Areas of Interest (AOIs), with support for administrative boundaries, forest reserves, watersheds, and global country boundaries.

---

## Overview

Forest monitoring in tropical regions is often constrained by persistent cloud cover, limiting the effectiveness of optical satellite imagery. This application addresses that challenge by leveraging Sentinel-1 C-band SAR data, which can penetrate clouds and provide consistent observations throughout the year.

The methodology is inspired by the TropiSCO approach developed by CNES, CESBIO, and GlobEO, where abrupt decreases in radar backscatter are used as indicators of forest disturbance and potential deforestation.

The application allows users to:

* Select an Area of Interest (AOI) from multiple boundary datasets.
* Generate a 2018 forest baseline.
* Detect annual forest loss from 2019 to the present.
* Explore monthly forest loss dynamics.
* Visualize cumulative forest loss and remaining forest cover.
* Calculate forest loss statistics.
* Generate charts showing annual loss trends and Sentinel-1 backscatter dynamics.

---

## Features

### Dynamic AOI Selection

Users can select AOIs from:

* Kenya Counties
* Kenya Constituencies
* Kenya Forest Boundaries
* Africa HydroSHEDS Level-10 Basins
* Muringato Basin
* Global Administrative Boundaries (ADM0)

### Forest Baseline Mapping

The forest mask is generated using:

* ESA WorldCover 2020 Tree Cover class
* Sentinel-1 VH backscatter threshold

### Annual Forest Loss Monitoring

* Baseline year: 2018
* Monitoring period: 2019–Present
* Annual median Sentinel-1 VH composites
* Detection of abrupt backscatter reductions

### Monthly Forest Loss Monitoring

* Monthly Sentinel-1 composites
* Near-real-time forest disturbance tracking
* Interactive month and year exploration

### Interactive Visualization
<img width="1917" height="960" alt="image" src="https://github.com/user-attachments/assets/a032fb9a-0312-4f95-a1f7-9ead7bdc1542" />

* Forest mask display
* Cumulative forest loss mapping
* Remaining forest mapping
* Annual and monthly loss exploration using sliders
* Dynamic colour gradients representing forest loss chronology

### Statistical Outputs

* Annual forest loss area (ha)
* Remaining forest area (ha)
* Cumulative forest loss area (ha)
* Sentinel-1 VH time series charts

---

## Methodology

### Data Sources

| Dataset                   | Source                      |
| ------------------------- | --------------------------- |
| Sentinel-1 GRD            | Copernicus                  |
| ESA WorldCover 2020       | ESA                         |
| Administrative Boundaries | User Assets / geoBoundaries |
| HydroSHEDS Basins         | User Assets                 |

---

### Forest Baseline

The baseline forest condition is established using the median Sentinel-1 VH backscatter for 2018:

```text
Baseline = Median(VH, 2018)
```

A pixel is considered forest if:

```text
ESA WorldCover Class = Tree Cover (Class 10)
AND
VH > -16 dB
```

---

### Forest Loss Detection

Forest loss is identified by comparing annual or monthly VH backscatter values against the 2018 baseline.

A pixel is classified as forest loss when:

```text
ΔVH < -5 dB
```

where:

```text
ΔVH = Current VH − Baseline VH
```

This approach assumes that substantial reductions in radar backscatter correspond to canopy removal or severe forest degradation.

---

### Forest Mask Cleaning

Morphological filtering is applied to reduce isolated noise pixels:

* Focal minimum
* Focal maximum

This improves spatial consistency of the forest mask.

---

### Cumulative Forest Loss

Each annual loss layer is assigned its corresponding year value.

The earliest detected loss year is retained for each pixel, enabling visualization of:

* Forest loss chronology
* Expansion of disturbed areas through time

---

## Workflow

### Step 1: Select Boundary Dataset
<img width="303" height="233" alt="image" src="https://github.com/user-attachments/assets/8c5a0db7-1208-49c4-8085-66f977bed092" />

Choose one of the available boundary layers from the dropdown menu.

### Step 2: Select Area of Interest
<img width="1512" height="651" alt="image" src="https://github.com/user-attachments/assets/277449bd-ad41-4bae-a420-f0918e9e4b03" />

For multi-polygon datasets:

* Click a feature on the map.
* The selected AOI is highlighted.

For Muringato Basin:

* AOI is automatically selected.

### Step 3: Run Analysis
<img width="290" height="84" alt="image" src="https://github.com/user-attachments/assets/26b12367-7768-4776-8f02-20ed7929337e" />

Click:

```text
Run Forest Loss Analysis
```

The application will:

1. Load Sentinel-1 imagery.
2. Generate the baseline.
3. Create the forest mask.
4. Detect annual loss.
5. Detect monthly loss.
6. Generate cumulative loss and statistics.

### Step 4: Explore Results
<img width="244" height="118" alt="image" src="https://github.com/user-attachments/assets/6a15f08a-32a2-414c-a9f8-f86775ddbfd0" />

Use:

* Annual mode
* Monthly mode
* Year slider
* Month slider

to explore forest loss dynamics.

---

## Colour Scheme
<img width="311" height="66" alt="image" src="https://github.com/user-attachments/assets/69d22e69-f1de-4d2b-8718-a7db7b68081e" />

Forest loss chronology is represented using the following gradient:

| Period          | Colour   |
| --------------- | -------- |
| Oldest Loss     | Yellow   |
| Early Loss      | Orange   |
| Mid-period Loss | Red      |
| Recent Loss     | Dark Red |

Remaining forest is displayed in dark green.

---

## Required Assets

The following Earth Engine assets are referenced by the application:

```text
projects/ee-cheruiyotkb/assets/kenya_counties

projects/ee-cheruiyotkb/assets/kenya_constituencies

projects/ee-cheruiyotkb/assets/kenya_forests

projects/ee-cheruiyotkb/assets/muringato_catchment

projects/ee-cheruiyotkb/assets/hybas_af_lev10_v1c
```

Users must replace these asset paths with their own if the assets are not accessible.

---

## Installation

### Prerequisites

* Google Earth Engine Account
* Access to the Earth Engine Code Editor

### Running the Application

1. Open Google Earth Engine Code Editor.
2. Create a new script.
3. Copy and paste the contents of:

```text
src/forest_loss_explorer.js
```

4. Run the script.

---

## Example Applications

The tool can be used for:

* Forest monitoring
* Watershed management
* Protected area surveillance
* REDD+ reporting
* Carbon accounting
* Environmental impact assessment
* Land-use change detection
* Biodiversity conservation

---

## Future Improvements

Potential enhancements include:

* weekly monitoring
* Automated alert generation
* Download buttons for current map views
* Feature search functionality
* Integration with Kenya Forest Service datasets
* Accuracy assessment and validation module
* Change-point detection algorithms

---

## Citation

If you use this application in research, please cite:

```text
Cheruiyot, B. K. (2026).
TropiSCO-inspired Forest Loss Explorer:
A Sentinel-1 SAR-based forest monitoring application in Google Earth Engine.
Dedan Kimathi University of Technology.
```

---

## Author

**Brian K. Cheruiyot**
Remote Sensing & GIS Researcher
Dedan Kimathi University of Technology (DeKUT)

---

## Acknowledgements

This work builds upon concepts from:

* TropiSCO Forest Monitoring System
* CNES
* CESBIO
* GlobEO
* Copernicus Sentinel Programme
* European Space Agency (ESA)
* Google Earth Engine Team

---

## License

MIT License

Copyright (c) 2026 Brian K. Cheruiyot

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files to deal in the Software without restriction.
