// =============================================================================
//                    TropiSCO-style Forest Loss Monitoring
// =============================================================================
// Methodology inspired by TropiSCO (CNES / CESBIO / GlobEO):
//   - Sentinel-1 SAR (C-band, VH polarisation) — cloud-penetrating radar
//   - Detects abrupt backscatter DECREASES over forest areas → deforestation
//   - Baseline: 2018 annual median; Analysis: 2019 to present
//
// *** KEY FEATURES IN THIS VERSION ***
//   - DYNAMIC AOI SELECTOR: user picks from 6 boundary datasets
//       (a) Kenya Counties
//       (b) Kenya Constituencies
//       (c) Africa HydroSHEDS (Level 10)
//       (d) Kenya Forests
//       (e) Muringato Basin (single polygon, auto-runs on select)
//       (f) Global Country Boundaries (ADM0)
//   - Multipolygon datasets: visualised on map; user clicks a feature to
//     set it as the AOI, then confirms via "Run Analysis" button
//   - Muringato Basin: single polygon, runs analysis immediately on select
//   - Forest mask: ESA WorldCover 2020 (class 10) + SAR threshold
//   - Interactive YEAR + MONTH sliders with yellow→dark red gradient
//   - Area statistics computed asynchronously (non-blocking UI)
//
// Author  : DeKUT's Remote Sensing Research Group
// Platform: Google Earth Engine (JavaScript API)
// Date    : 2026
// =============================================================================


// =============================================================================
// SECTION 1 - MAP SETUP
// =============================================================================

Map.setOptions('SATELLITE');
Map.setCenter(37.5, 0.5, 6); // Zoom to Kenya on load

// Month name lookup — used by the month slider label
var MONTH_NAMES = [
  'Jan','Feb','Mar','Apr','May','Jun',
  'Jul','Aug','Sep','Oct','Nov','Dec'
];

// Loss colour palette (yellow → dark red): shared by map, legend, and sliders
var LOSS_PALETTE = ['FFFF00','FFA500','FF4500','FF0000','CC0000','990000','660000'];

// Time parameters (fixed)
var START_YEAR  = 2018;
var TODAY       = new Date();
var END_YEAR    = TODAY.getFullYear();
var START_DATE  = ee.Date.fromYMD(START_YEAR, 1, 1);
var END_DATE    = ee.Date(TODAY);

// SAR / loss thresholds
var SAR_FOREST_THRESHOLD = -16; // dB: minimum 2018 VH to qualify as forest
var LOSS_THRESHOLD       = -5;  // dB: drop vs 2018 baseline to flag as loss

// Layer name constants (used to manage dynamic layers)
var LAYER_BOUNDARY   = 'Boundary Layer';
var LAYER_SELECTED   = 'Selected AOI';
var LAYER_FOREST_MASK= 'Forest Mask 2018';
var LAYER_CUMULATIVE = 'Cumulative Loss';
var LAYER_REMAINING  = 'Remaining Forest';
var LAYER_SLIDER     = 'Selected Period -> Forest Loss';


// =============================================================================
// SECTION 2: BOUNDARY DATASET DEFINITIONS
// =============================================================================
// Each entry defines:
//   id         : internal key
//   label      : shown in the dropdown
//   asset      : GEE asset path or ee.FeatureCollection constructor call
//   isBuiltIn  : true if loaded via ee.FeatureCollection() rather than an asset
//   isSingle   : true if the collection has exactly one polygon (Muringato)
//   nameField  : the attribute field containing a human-readable feature name
//                (used in the info label when a feature is clicked)

var BOUNDARIES = [
  {
    id:         'counties',
    label:      'Kenya Counties',
    asset:      'projects/ee-cheruiyotkb/assets/kenya_counties',
    isBuiltIn:  false,
    isSingle:   false,
    nameField:  'COUNTY_NAM'
  },
  {
    id:         'constituencies',
    label:      'Kenya Constituencies',
    asset:      'projects/ee-cheruiyotkb/assets/kenya_constituencies',
    isBuiltIn:  false,
    isSingle:   false,
    nameField:  'const_nam'
  },
  {
    id:         'hydrosheds',
    label:      'Africa HydroSHEDS (L10)',
    asset:      'projects/ee-cheruiyotkb/assets/hybas_af_lev10_v1c',
    isBuiltIn:  false,
    isSingle:   false,
    nameField:  'HYBAS_ID'      // standard ID field
  },
  {
    id:         'forests',
    label:      'Kenya Forests',
    asset:      'projects/ee-cheruiyotkb/assets/kenya_forests',
    isBuiltIn:  false,
    isSingle:   false,
    nameField:  'Feature Index'
  },
  {
    id:         'muringato',
    label:      'Muringato Basin',
    asset:      'projects/ee-cheruiyotkb/assets/muringato_catchment',
    isBuiltIn:  false,
    isSingle:   true,           // only one polygon → run immediately
    nameField:  null
  },
  {
    id:         'world',
    label:      'Global Countries (ADM0)',
    asset:      'WM/geoLab/geoBoundaries/600/ADM0',
    isBuiltIn:  true,           // loaded via ee.FeatureCollection() directly
    nameField:  'shapeName'     // geoBoundaries standard name field
  }
];


// =============================================================================
// SECTION 3: STATE VARIABLES
// =============================================================================
// All mutable state is held in plain JavaScript variables.
// When the AOI changes, runAnalysis() rebuilds all ee objects from scratch.

var state = {
  currentBoundaryId:  null,   // which boundary set is loaded
  currentCollection:  null,   // the ee.FeatureCollection currently displayed
  selectedFeature:    null,   // the ee.Feature the user clicked
  selectedGeom:       null,   // geometry of the selected feature (client-usable)
  analysisRunning:    false,  // prevents double-clicking Run
  currentMode:        'Annual Loss',

  // These are set after runAnalysis() completes:
  s1:                 null,
  baseline:           null,
  forestMask2018:     null,
  forestMaskCleaned:  null,
  forestAreaHa2018:   null,
  annualCollection:   null,
  monthlyCollection:  null,
  lossAreaByYear:     null,
  lossPercentByYear:  null,
  totalLossHa:        null,
  remainingForestHa:  null
};


// =============================================================================
// SECTION 4: COLOUR UTILITIES
// =============================================================================
// Client-side RGB interpolation along the loss palette.
// Used to colour slider labels and dynamically rendered map layers.

var PALETTE_RGB = [
  [255,255,  0],  // FFFF00
  [255,165,  0],  // FFA500
  [255, 69,  0],  // FF4500
  [255,  0,  0],  // FF0000
  [204,  0,  0],  // CC0000
  [153,  0,  0],  // 990000
  [102,  0,  0],  // 660000
];

var interpolateColor = function(t) {
  t = Math.max(0, Math.min(1, t));
  var n   = PALETTE_RGB.length - 1;
  var idx = Math.min(Math.floor(t * n), n - 1);
  var rem = (t * n) - idx;
  var c1  = PALETTE_RGB[idx];
  var c2  = PALETTE_RGB[Math.min(idx + 1, n)];
  var r   = Math.round(c1[0] + rem * (c2[0] - c1[0]));
  var g   = Math.round(c1[1] + rem * (c2[1] - c1[1]));
  var b   = Math.round(c1[2] + rem * (c2[2] - c1[2]));
  var hex = function(v) { var h = v.toString(16); return h.length === 1 ? '0'+h : h; };
  return '#' + hex(r) + hex(g) + hex(b);
};

var yearToT = function(year) {
  return (year - 2019) / Math.max(END_YEAR - 2019, 1);
};


// =============================================================================
// SECTION 5: MAP LAYER MANAGEMENT HELPERS
// =============================================================================
// GEE has no native "update layer" API, so we manually scan Map.layers()
// by name and remove the old layer before adding the new one.

var removeLayerByName = function(name) {
  var layers = Map.layers();
  for (var i = layers.length() - 1; i >= 0; i--) {
    if (layers.get(i).getName() === name) {
      Map.remove(layers.get(i));
    }
  }
};

var setLayer = function(image, visParams, name, shown) {
  removeLayerByName(name);
  Map.addLayer(image, visParams, name, shown !== false);
};

var setVectorLayer = function(fc, color, name, shown) {
  removeLayerByName(name);
  Map.addLayer(
    fc.style({fillColor: color + '33', color: color, width: 1.5}),
    {}, name, shown !== false
  );
};


// =============================================================================
// SECTION 6: MAIN UI PANEL CONSTRUCTION
// =============================================================================

var panel = ui.Panel({
  style: {
    position:        'top-left',
    width:           '335px',
    maxHeight:       '70vh',      // limits height to 70% of viewport
    padding:         '10px',
    backgroundColor: '#eeeeee',
    border:          '2px solid #444'
  }
});

// ── Header ───────────────────────────────────────────────────────────────────
panel.add(ui.Label({
  value: 'Forest Loss Explorer',
  style: {fontWeight:'bold', fontSize:'20px', color:'#000', backgroundColor: '#eeeeee', margin:'0 0 2px 60px', textAlign:'center'}
}));
panel.add(ui.Label({
  value: 'TropiSCO-inspired · Sentinel-1 SAR · 10 m',
  style: {fontSize:'9px', fontStyle:'italic', backgroundColor: '#eeeeee', color:'#777', margin:'0 0 8px 75px', textAlign:'center'}
}));
panel.add(ui.Label('──────────────────────────────', {color:'#bbb', backgroundColor: '#eeeeee', margin:'0 0 8px 0', textAlign:'center'}));


// ── Step 1: Boundary selector ─────────────────────────────────────────────────
panel.add(ui.Label({
  value: 'STEP 1. Select Boundary',
  style: {fontWeight:'bold', fontSize:'11px', backgroundColor: '#eeeeee', color:'#333', margin:'0 0 4px 0'}
}));
panel.add(ui.Label({
  value: 'Choose a boundary dataset. For multi-polygon layers, click the specific boundary on the map to select it as AOI.',
  style: {fontSize:'10px', color:'#444444', backgroundColor: '#eeeeee', margin:'0 0 6px 0', whiteSpace:'wrap'}
}));

// Build dropdown items from BOUNDARIES array
var dropdownItems = BOUNDARIES.map(function(b) { return b.label; });

var boundarySelect = ui.Select({
  items:       dropdownItems,
  placeholder: '— Select a boundary dataset —',
  style:       {width:'276px', margin:'0 0 6px 0'},
  onChange:    function(val) { onBoundarySelect(val); }
});
panel.add(boundarySelect);

// Info label shown after a feature is clicked on the map
var featureInfoLabel = ui.Label({
  value: '',
  style: {fontSize:'10px', color:'#1a6e1a', fontWeight:'bold',
          backgroundColor:'#d4f1d4', padding:'4px', margin:'4px 0 6px 0',
          shown: false}
});
panel.add(featureInfoLabel);

// Instruction label (changes based on dataset type)
var instructionLabel = ui.Label({
  value: '',
  style: {fontSize:'10px', color:'#555', margin:'0 0 8px 0', whiteSpace:'wrap', shown:false}
});
panel.add(instructionLabel);


// ── Step 2: Run Analysis button ───────────────────────────────────────────────
panel.add(ui.Label('──────────────────────────────', {color:'#bbb', backgroundColor: '#eeeeee', margin:'0 0 8px 0', textAlign:'center'}));
panel.add(ui.Label({
  value: 'STEP 2. Run Analysis',
  style: {fontWeight:'bold', fontSize:'11px', backgroundColor: '#eeeeee', color:'#333', margin:'0 0 4px 0'}
}));

var runButton = ui.Button({
  label:   '▶  Run Forest Loss Analysis',
  style:   {width:'276px', color:'#274e13', backgroundColor:'#2d6a2d',
            fontWeight:'bold', margin:'0 0 6px 0', shown:false},
  onClick: function() { runAnalysis(); }
});
panel.add(runButton);

// Status label (shows pipeline progress messages)
var pipelineStatusLabel = ui.Label({
  value: '',
  style: {fontSize:'10px', color:'#555', margin:'0 0 4px 0', whiteSpace:'pre', shown:false}
});
panel.add(pipelineStatusLabel);


// ── Divider ───────────────────────────────────────────────────────────────────
panel.add(ui.Label('──────────────────────────────', {color:'#bbb', backgroundColor: '#eeeeee', margin:'0 0', textAlign:'center'}));


// ── Colour bar ────────────────────────────────────────────────────────────────
panel.add(ui.Label({
  value: 'Loss Colour Scale',
  style: {fontWeight:'bold', fontSize:'11px', backgroundColor: '#eeeeee', color:'#333', margin:'0 0 4px 0'}
}));

var colorBarPanel = ui.Panel({
  layout: ui.Panel.Layout.flow('horizontal'),
  style:  {margin:'0 0 2px 0'}
});
var NUM_STOPS = 26;
for (var ci = 0; ci < NUM_STOPS; ci++) {
  colorBarPanel.add(ui.Label({
    style: {
      backgroundColor: interpolateColor(ci / (NUM_STOPS - 1)),
      padding: '6px',
      margin:  '0',
      width:   Math.floor(276 / NUM_STOPS) + 'px'
    }
  }));
}
panel.add(colorBarPanel);

var cbRow = ui.Panel({layout: ui.Panel.Layout.flow('horizontal'), style: {backgroundColor: '#eeeeee'}});
cbRow.add(ui.Label('2019', {fontSize:'8px', backgroundColor: '#eeeeee', color:'#777'}));
cbRow.add(ui.Label('', {stretch:'horizontal'}));
cbRow.add(ui.Label(String(END_YEAR), {fontSize:'8px', color:'#777', backgroundColor: '#eeeeee'}));
panel.add(cbRow);
panel.add(ui.Label('──────────────────────────────', {color:'#bbb', margin:'8px 0', backgroundColor: '#eeeeee', textAlign:'center'}));


// ── Slider section (shown only after analysis runs) ───────────────────────────
var sliderSection = ui.Panel({style: {shown:false}});

sliderSection.add(ui.Label({
  value: 'STEP 3. Explore Results',
  style: {fontWeight:'bold', fontSize:'11px', color:'#333', margin:'0 0 4px 0'}
}));

// Mode dropdown
sliderSection.add(ui.Label('View Mode', {fontWeight:'bold', fontSize:'10px', color:'#555', margin:'0 0 3px 0'}));
var modeSelect = ui.Select({
  items:    ['Annual Loss', 'Monthly Loss'],
  value:    'Annual Loss',
  style:    {width:'276px', margin:'0 0 8px 0'},
  onChange: function(val) { onModeChange(val); }
});
sliderSection.add(modeSelect);

// Year slider
sliderSection.add(ui.Label('Select Year', {fontWeight:'bold', fontSize:'10px', color:'#555',
                                          margin:'0 0 3px 0'}));

var yearSliderLabel = ui.Label({
  value: '2019',
  style: {fontWeight:'bold', fontSize:'22px', color:'#FFFF00',
          margin:'0 0 4px 0', textAlign:'center'}
});
sliderSection.add(yearSliderLabel);

var yearSlider = ui.Slider({
  min: 2019, max: END_YEAR, value: 2019, step: 1,
  style: {stretch:'horizontal', margin:'0 0 2px 0'},
  onChange: function(val) { onYearSliderChange(val); }
});
sliderSection.add(yearSlider);

var yearRangeRow = ui.Panel({layout: ui.Panel.Layout.flow('horizontal')});
yearRangeRow.add(ui.Label('2019', {fontSize:'8px', color:'#777'}));
yearRangeRow.add(ui.Label('', {stretch:'horizontal'}));
yearRangeRow.add(ui.Label(String(END_YEAR), {fontSize:'8px', color:'#777'}));
sliderSection.add(yearRangeRow);

// Month slider (hidden until Monthly mode selected)
var monthSection = ui.Panel({style: {shown:false, backgroundColor:'#eeeeee'}});
monthSection.add(ui.Label('──────────────────────────────', {color:'#bbb', margin:'6px 0 6px 0', textAlign:'center'}));
monthSection.add(ui.Label('Select Month', {fontWeight:'bold', fontSize:'10px', color:'#555', margin:'0 0 3px 0'}));

var monthSliderLabel = ui.Label({
  value: 'January',
  style: {fontWeight:'bold', fontSize:'18px', color:'#FFFF00',
          backgroundColor:'#eeeeee', margin:'0 0 4px 0', textAlign:'center'}
});
monthSection.add(monthSliderLabel);

var monthSlider = ui.Slider({
  min:1, max:12, value:1, step:1,
  style: {stretch:'horizontal', margin:'0 0 2px 0'},
  onChange: function(val) { onMonthSliderChange(val); }
});
monthSection.add(monthSlider);

var monthRangeRow = ui.Panel({layout: ui.Panel.Layout.flow('horizontal')});
monthRangeRow.add(ui.Label('Jan', {fontSize:'8px', color:'#777'}));
monthRangeRow.add(ui.Label('', {stretch:'horizontal'}));
monthRangeRow.add(ui.Label('Dec', {fontSize:'8px', color:'#777'}));
monthSection.add(monthRangeRow);
sliderSection.add(monthSection);

// Status and stat labels
sliderSection.add(ui.Label('──────────────────────────────', {color:'#bbb', margin:'8px 0', textAlign:'center'}));
sliderSection.add(ui.Label('Displaying', {fontWeight:'bold', fontSize:'10px', color:'#555', margin:'0 0 3px 0'}));

var statusLabel = ui.Label({
  value: '—',
  style: {fontSize:'12px', color:'#222', fontWeight:'bold', margin:'0 0 4px 0'}
});
sliderSection.add(statusLabel);

var statLabel = ui.Label({
  value: '',
  style: {fontSize:'12px', fontStyle:'italic', color:'#888', margin:'0 0 4px 0'}
});
sliderSection.add(statLabel);

sliderSection.add(ui.Label({
  value: 'Area stats compute server-side; allow a few seconds.',
  style: {fontSize:'10px', color:'#aaa', margin:'2px 0 0 10px'}
}));

panel.add(sliderSection);


// ── How to Use ────────────────────────────────────────────────────────────────
panel.add(ui.Label('How to Use', {fontWeight:'bold', fontSize:'12px', color:'#333', margin:'0 0 0 100px', backgroundColor: '#eeeeee'}));
panel.add(ui.Label('──────────────────────────────', {color:'#000000', margin:'0 0 8px', backgroundColor: '#eeeeee', textAlign:'center'}));

panel.add(ui.Label({
  value:
    '1. Select a boundary dataset.\n' +
    '2. For multi-polygon datasets, click a feature on the map.\n' +
    '3. Click "Run Forest Loss Analysis".\n' +
    '4. Use sliders to explore results.\n' +
    '    Yellow = oldest  ·  Dark Red = newest',
  style: {fontSize:'9px', color:'#888', whiteSpace:'pre', margin:'0 20px', backgroundColor: '#eeeeee'}
}));

Map.add(panel);


// =============================================================================
// SECTION 7. STATIC LEGEND (bottom-left)
// =============================================================================

var legend = ui.Panel({
  style: {
    position: 'bottom-right', padding:'8px 12px',
    backgroundColor:'#eeeeee', border:'2px solid #444'
  }
});
legend.add(ui.Label('Legend', {fontWeight:'bold', backgroundColor: '#eeeeee', fontSize:'12px', color:'#000', margin:'0 0 6px 0'}));

var addLegendRow = function(color, label) {
  var row = ui.Panel({layout: ui.Panel.Layout.flow('horizontal')});
  row.add(ui.Label({style:{backgroundColor:'#'+color, padding:'6px', margin:'0 6px 2px 0', border:'1px solid #888'}}));
  row.add(ui.Label(label, {fontSize:'9px', color:'#444', margin:'3px 0'}));
  legend.add(row);
};

addLegendRow('f3f6f4', 'AOI Boundary');
addLegendRow('00CC44', 'Forest Mask 2018');
addLegendRow('006400', 'Remaining Stable Forest');
legend.add(ui.Label('— Loss Year —', {fontSize:'10px', backgroundColor:'#eeeeee', fontStyle:'bold', color:'#888', margin:'4px 0 2px 0', textAlign:'center'}));
addLegendRow('FFFF00', '2019');
addLegendRow('FFA500', '2020');
addLegendRow('FF4500', '2021');
addLegendRow('FF0000', '2022');
addLegendRow('CC0000', '2023');
addLegendRow('990000', '2024');
addLegendRow('660000', '2025+');
legend.add(ui.Label({
  value: '--> Sentinel-1 SAR (VH, IW)\n--> ESA WorldCover 2020\n--> TropiSCO-inspired · 10 m',
  style: {fontSize:'7px', color:'#5b5b5b', margin:'6px 0 0 10px', backgroundColor: '#eeeeee', whiteSpace:'pre'}
}));
Map.add(legend);


// =============================================================================
// SECTION 8. BOUNDARY SELECT HANDLER
// =============================================================================
// Called when the user picks a boundary dataset from the dropdown.
// Loads the collection, displays it on the map, sets up click handler,
// and (for Muringato) auto-sets the AOI and shows Run button immediately.

var onBoundarySelect = function(label) {
  // Find the boundary definition matching the selected label
  var def = null;
  for (var i = 0; i < BOUNDARIES.length; i++) {
    if (BOUNDARIES[i].label === label) { def = BOUNDARIES[i]; break; }
  }
  if (!def) return;

  state.currentBoundaryId = def.id;
  state.selectedFeature   = null;
  state.selectedGeom      = null;

  // Reset UI elements
  featureInfoLabel.style().set('shown', false);
  featureInfoLabel.setValue('');
  runButton.style().set('shown', false);
  pipelineStatusLabel.style().set('shown', false);
  sliderSection.style().set('shown', false);
  instructionLabel.style().set('shown', true);

  // Clear previous boundary and selection layers
  removeLayerByName(LAYER_BOUNDARY);
  removeLayerByName(LAYER_SELECTED);
  removeLayerByName(LAYER_FOREST_MASK);
  removeLayerByName(LAYER_CUMULATIVE);
  removeLayerByName(LAYER_REMAINING);
  removeLayerByName(LAYER_SLIDER);

  // Load the collection
  var fc = def.isBuiltIn
    ? ee.FeatureCollection(def.asset)
    : ee.FeatureCollection(def.asset);

  state.currentCollection = fc;

  if (def.isSingle) {
    // ── Muringato: single polygon — select it automatically ──────────────────
    instructionLabel.setValue('Single polygon detected. Click "Run Analysis" to proceed.');
    instructionLabel.style().set('backgroundColor', '#eeeeee');

    var singleFeature = fc.first();
    state.selectedGeom = fc.geometry();

    // Display the boundary
    setVectorLayer(fc, 'F0F0F0', LAYER_BOUNDARY, true);
    Map.centerObject(fc, 10);

    featureInfoLabel.setValue('✔ Muringato Basin selected');
    featureInfoLabel.style().set('shown', true);
    runButton.style().set('shown', true);

  } else {
    // ── Multi-polygon: display all features; wait for user to click one ──────
    instructionLabel.setValue(
      'Layer loaded. Click any feature on the map to select it as your AOI.'
    );
    instructionLabel.style().set('backgroundColor', '#eeeeee');
    // show clickable state
    Map.style().set('cursor', 'hand');
    
    // Display the full collection as a light-shaded layer
    setVectorLayer(fc, '#f3f6f4', LAYER_BOUNDARY, true);
    Map.centerObject(fc, 6);

    // Register click handler on the map
    // We use Map.onClick to detect clicks, then find the nearest feature
    Map.onClick(function(coords) {
      onMapClick(coords, def, fc);
    });
  }
};


// =============================================================================
// SECTION 9. MAP CLICK HANDLER (for multi-polygon datasets)
// =============================================================================
// When the user clicks the map, we filter the collection to the feature
// containing the clicked point, highlight it, and enable the Run button.

var onMapClick = function(coords, def, fc) {
  var clickedPoint = ee.Geometry.Point([coords.lon, coords.lat]);

  // Find the feature that contains the clicked point
  var clickedFeature = fc.filterBounds(clickedPoint).first();

  // Use evaluate() to bring the feature to the client side for UI feedback
  clickedFeature.evaluate(function(result) {
    if (!result) {
      featureInfoLabel.setValue('⚠ No feature found at that location. Try clicking again.');
      featureInfoLabel.style().set('shown', true);
      return;
    }
    // cursor state
    Map.style().set('cursor', 'crosshair');
    
    // Store selected geometry on state as an ee object
    state.selectedGeom = ee.Feature(result).geometry();

    // Display the selected feature highlighted on the map
    var selectedFc = ee.FeatureCollection([ee.Feature(result)]);
    setVectorLayer(selectedFc, 'D12A2A', LAYER_SELECTED, true);

    // Show name of selected feature in the info label
    var name = '';
    if (def.nameField && result.properties && result.properties[def.nameField] !== undefined) {
      name = String(result.properties[def.nameField]);
    } else {
      name = 'Feature selected';
    }

    featureInfoLabel.setValue('✔ Selected: ' + name);
    featureInfoLabel.style().set('shown', true);

    // Show the Run button
    runButton.style().set('shown', true);
    pipelineStatusLabel.setValue('AOI ready. Click "Run Forest Loss Analysis".');
    pipelineStatusLabel.style().set('shown', true);

    // Zoom to the selected feature
    Map.centerObject(state.selectedGeom, 10);
  });
};


// =============================================================================
// SECTION 10. MAIN ANALYSIS PIPELINE
// =============================================================================
// Called when the user clicks the Run button.
// Rebuilds the entire ee pipeline for the selected AOI geometry, then
// adds results to the map and activates the sliders.

var runAnalysis = function() {
  if (state.analysisRunning) return;
  if (!state.selectedGeom) {
    pipelineStatusLabel.setValue('⚠ No AOI selected. Please select a feature first.');
    pipelineStatusLabel.style().set('shown', true);
    return;
  }

  state.analysisRunning = true;
  runButton.style().set({backgroundColor:'#777', color:'#ccc'});
  runButton.setLabel('⏳  Computing…');

  pipelineStatusLabel.setValue('Step 1/6: Loading Sentinel-1 data…');
  pipelineStatusLabel.style().set('shown', true);

  var aoiGeom = state.selectedGeom;

  // ── Step 1: Sentinel-1 collection ─────────────────────────────────────────
  var s1 = ee.ImageCollection('COPERNICUS/S1_GRD')
    .filterBounds(aoiGeom)
    .filterDate(START_DATE, END_DATE)
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
    .select('VH');

  state.s1 = s1;

  // ── Step 2: 2018 Baseline ─────────────────────────────────────────────────
  pipelineStatusLabel.setValue('Step 2/6: Building 2018 SAR baseline…');

  var baseline = s1
    .filterDate('2018-01-01', '2018-12-31')
    .median()
    .clip(aoiGeom);

  state.baseline = baseline;

  // ── Step 3: ESA WorldCover + SAR forest mask ──────────────────────────────
  pipelineStatusLabel.setValue('Step 3/6: Creating forest mask (WorldCover + SAR)…');

  var worldCover = ee.ImageCollection('ESA/WorldCover/v100')
    .first()
    .clip(aoiGeom);

  var wcForestMask = worldCover.eq(10); // Class 10 = Tree Cover

  var forestMask2018 = wcForestMask
    .and(baseline.gt(SAR_FOREST_THRESHOLD))
    .rename('forest_mask');

  var forestMaskCleaned = forestMask2018
    .focal_min({radius:1, kernelType:'square', units:'pixels'})
    .focal_max({radius:1, kernelType:'square', units:'pixels'})
    .selfMask();

  state.forestMask2018    = forestMask2018;
  state.forestMaskCleaned = forestMaskCleaned;

  setLayer(forestMaskCleaned, {palette:['00CC44']}, LAYER_FOREST_MASK, false);

  // Forest area (async — won't block pipeline)
  ee.Image.pixelArea()
    .updateMask(forestMaskCleaned)
    .reduceRegion({reducer: ee.Reducer.sum(), geometry: aoiGeom, scale:10, maxPixels:1e13})
    .evaluate(function(r) {
      if (r && r.area !== undefined) {
        state.forestAreaHa2018 = r.area / 10000;
        pipelineStatusLabel.setValue(
          'Step 3/6: Forest mask created. Forest area: ' + state.forestAreaHa2018.toFixed(1) + ' ha'
        );
      }
    });

  // ── Step 4: Annual loss detection ─────────────────────────────────────────
  pipelineStatusLabel.setValue('Step 4/6: Computing annual loss maps (2019 to ' + END_YEAR + ')…');

  var years = ee.List.sequence(2019, END_YEAR);

  var detectAnnualLoss = function(year) {
    year = ee.Number(year);
    var ys = ee.Date.fromYMD(year, 1, 1);
    var ye = ee.Date.fromYMD(year, 12, 31);
    var med = s1.filterDate(ys, ye).median().clip(aoiGeom);
    var diff = med.subtract(baseline);
    return diff.lt(LOSS_THRESHOLD)
      .updateMask(forestMask2018)
      .updateMask(diff.lt(LOSS_THRESHOLD))
      .rename('forest_loss').toFloat()
      .set('year', year)
      .set('system:time_start', ys.millis());
  };

  var annualCollection = ee.ImageCollection(years.map(detectAnnualLoss));
  state.annualCollection = annualCollection;

  // ── Step 5: Monthly loss detection ────────────────────────────────────────
  pipelineStatusLabel.setValue('Step 5/6: Building monthly loss collection…');

  var totalMonths   = (END_YEAR - 2019) * 12 + TODAY.getMonth();
  var monthlyOffsets = ee.List.sequence(0, totalMonths);

  var detectMonthlyLoss = function(offset) {
    var start = ee.Date('2019-01-01').advance(offset, 'month');
    var end   = start.advance(1, 'month');
    var med   = s1.filterDate(start, end).median().clip(aoiGeom);
    var diff  = med.subtract(baseline);
    return diff.lt(LOSS_THRESHOLD)
      .updateMask(forestMask2018)
      .updateMask(diff.lt(LOSS_THRESHOLD))
      .rename('monthly_forest_loss').toFloat()
      .set('year',        start.get('year'))
      .set('month',       start.get('month'))
      .set('month_label', start.format('YYYY-MM'))
      .set('system:time_start', start.millis());
  };

  state.monthlyCollection = ee.ImageCollection(monthlyOffsets.map(detectMonthlyLoss));

  // ── Step 6: Cumulative loss + remaining forest ─────────────────────────────
  pipelineStatusLabel.setValue('Step 6/6: Building cumulative loss and remaining forest maps…');

  var yearCodedLoss = annualCollection.map(function(img) {
    return img.multiply(ee.Number(img.get('year'))).rename('loss_year');
  });

  var cumulativeLossYear = yearCodedLoss
    .reduce(ee.Reducer.min())
    .updateMask(yearCodedLoss.reduce(ee.Reducer.max()).gt(0))
    .rename('first_loss_year');

  var remainingForest = forestMaskCleaned
    .updateMask(cumulativeLossYear.unmask(0).eq(0));

  setLayer(
    cumulativeLossYear,
    {min:2019, max:END_YEAR, palette:LOSS_PALETTE},
    LAYER_CUMULATIVE, true
  );

  setLayer(remainingForest, {palette:['006400']}, LAYER_REMAINING, true);

  // ── Statistics ─────────────────────────────────────────────────────────────
  // Annual loss area (server-side async)
  var computeLossArea = function(img) {
    var yr = img.get('year');
    var area = ee.Image.pixelArea()
      .updateMask(img)
      .reduceRegion({reducer:ee.Reducer.sum(), geometry:aoiGeom, scale:10, maxPixels:1e13})
      .get('area');
    return ee.Feature(null, {
      'year': yr,
      'loss_area_ha': ee.Number(area).divide(10000)
    });
  };

  var lossAreaByYear = ee.FeatureCollection(annualCollection.map(computeLossArea));

  var lossPercentByYear = lossAreaByYear.map(function(feat) {
    var lossHa      = ee.Number(feat.get('loss_area_ha'));
    var forestHa    = forestMaskCleaned
      .reduceRegion({reducer:ee.Reducer.sum(), geometry:aoiGeom, scale:100, maxPixels:1e13})
      .get('forest_mask'); // pixel count at 100 m scale for efficiency
    // We use a simpler approach: divide by evaluated forest area stored in state
    return feat.set('loss_pct', lossHa.divide(
      ee.Image.pixelArea().updateMask(forestMaskCleaned)
        .reduceRegion({reducer:ee.Reducer.sum(), geometry:aoiGeom, scale:100, maxPixels:1e13})
        .get('area')
    ).multiply(1000000)); // scale back from 100m→10m (100x pixel area)
  });

  state.lossAreaByYear    = lossAreaByYear;
  state.lossPercentByYear = lossPercentByYear;

  // Total cumulative loss (async for display)
  ee.Image.pixelArea()
    .updateMask(cumulativeLossYear.gt(0))
    .reduceRegion({reducer:ee.Reducer.sum(), geometry:aoiGeom, scale:10, maxPixels:1e13})
    .evaluate(function(r) {
      state.totalLossHa = r && r.area ? r.area / 10000 : 0;
    });

  ee.Image.pixelArea()
    .updateMask(remainingForest)
    .reduceRegion({reducer:ee.Reducer.sum(), geometry:aoiGeom, scale:10, maxPixels:1e13})
    .evaluate(function(r) {
      state.remainingForestHa = r && r.area ? r.area / 10000 : 0;
    });

  // ── Charts ─────────────────────────────────────────────────────────────────
  var lossAreaChart = ui.Chart.feature.byFeature({
    features:    lossAreaByYear,
    xProperty:   'year',
    yProperties: ['loss_area_ha']
  }).setChartType('ColumnChart').setOptions({
    title:'Annual Forest Loss Area (ha)',
    hAxis:{title:'Year'}, vAxis:{title:'Forest Loss (ha)'},
    colors:['#d73027'], legend:{position:'none'}, bar:{groupWidth:'65%'}
  });

  print('── Annual Forest Loss Area Chart ──');
  print(lossAreaChart);

  var tsChart = ui.Chart.image.series({
    imageCollection: s1.select('VH'),
    region:          aoiGeom,
    reducer:         ee.Reducer.mean(),
    scale:           100, // coarser scale for full-AOI mean (faster)
    xProperty:       'system:time_start'
  }).setChartType('LineChart').setOptions({
    title:'S1 VH Backscatter Mean Time Series — AOI',
    hAxis:{title:'Date', format:'MMM-YYYY'},
    vAxis:{title:'Mean VH Backscatter (dB)'},
    lineWidth:1, pointSize:2, colors:['#1a9641']
  });

  print('── Sentinel-1 VH Time Series ──');
  print(tsChart);

  // ── Finalise UI ────────────────────────────────────────────────────────────
  state.analysisRunning = false;
  runButton.setLabel('✔  Analysis Complete, Rerun');
  runButton.style().set({backgroundColor:'#eeeeee', color:'#466945'});

  pipelineStatusLabel.setValue(
    '✔ Analysis complete.\n' +
    'Use sliders below to explore loss by year/month.'
  );
  pipelineStatusLabel.style().set('backgroundColor', '#eeeeee');

  // Show the slider section and initialise at 2019
  sliderSection.style().set('shown', true);
  yearSlider.setValue(2019, false);
  onYearSliderChange(2019);

  // Summary in console
  print('');
  print('══════════════════════════════════════════════');
  print('   TropiSCO ANALYSIS SUMMARY');
  print('══════════════════════════════════════════════');
  print('Boundary  : ' + boundarySelect.getValue());
  print('Baseline  : 2018 · Analysis: 2019 – ' + END_YEAR);
  print('Satellite : Sentinel-1 C-band SAR (VH, IW)');
  print('Forest    : ESA WorldCover 2020 (class 10)');
  print('SAR floor : VH > ' + SAR_FOREST_THRESHOLD + ' dB');
  print('Loss flag : ΔVH < ' + LOSS_THRESHOLD + ' dB');
  print('Resolution: 10 m');
  print('Annual loss area table:', lossAreaByYear);
  print('══════════════════════════════════════════════');
};


// =============================================================================
// SECTION 11 — SLIDER EVENT HANDLERS
// =============================================================================

// Helper: replace slider layer and update area stat label
var updateSliderLayerAndStat = function(lossImg, color, periodLabel) {
  removeLayerByName(LAYER_SLIDER);
  Map.addLayer(lossImg, {palette:[color], min:0, max:1}, LAYER_SLIDER, true);

  statLabel.setValue('Computing area…');

  if (!state.selectedGeom) return;

  ee.Image.pixelArea()
    .updateMask(lossImg)
    .reduceRegion({
      reducer:   ee.Reducer.sum(),
      geometry:  state.selectedGeom,
      scale:     10,
      maxPixels: 1e13
    })
    .evaluate(function(r) {
      if (r && r.area !== undefined) {
        statLabel.setValue('Loss area: ' + (r.area / 10000).toFixed(1) + ' ha (' + periodLabel + ')');
      } else {
        statLabel.setValue('No loss detected / no data for this period.');
      }
    });
};

// Year slider handler
var onYearSliderChange = function(year) {
  if (!state.annualCollection) return;
  year = Math.round(year);

  var t   = yearToT(year);
  var clr = interpolateColor(t);
  yearSliderLabel.setValue(String(year));
  yearSliderLabel.style().set('color', clr);

  if (state.currentMode === 'Monthly Loss') {
    onMonthSliderChange(monthSlider.getValue());
    return;
  }

  statusLabel.setValue('Annual loss — ' + year);
  var lossImg = state.annualCollection.filter(ee.Filter.eq('year', year)).first();
  updateSliderLayerAndStat(lossImg, clr, String(year));
};

// Month slider handler
var onMonthSliderChange = function(month) {
  if (!state.monthlyCollection) return;
  month = Math.round(month);
  var year = Math.round(yearSlider.getValue());

  var yearFrac  = yearToT(year);
  var monthFrac = (month - 1) / 11;
  var sliceFrac = 1 / Math.max(END_YEAR - 2019, 1);
  var t         = Math.min(yearFrac + monthFrac * sliceFrac, 1);
  var clr       = interpolateColor(t);

  monthSliderLabel.setValue(MONTH_NAMES[month - 1]);
  monthSliderLabel.style().set('color', clr);
  yearSliderLabel.setValue(String(year));
  yearSliderLabel.style().set('color', interpolateColor(yearToT(year)));

  var monthStr    = month < 10 ? '0' + month : String(month);
  var labelFilter = year + '-' + monthStr;
  var periodLabel = MONTH_NAMES[month - 1] + ' ' + year;

  statusLabel.setValue('Monthly loss — ' + periodLabel);

  var lossImg = state.monthlyCollection
    .filter(ee.Filter.eq('month_label', labelFilter))
    .first();
  updateSliderLayerAndStat(lossImg, clr, periodLabel);
};

// Mode switch handler
var onModeChange = function(mode) {
  state.currentMode = mode;
  if (mode === 'Monthly Loss') {
    monthSection.style().set('shown', true);
    onMonthSliderChange(monthSlider.getValue());
  } else {
    monthSection.style().set('shown', false);
    onYearSliderChange(yearSlider.getValue());
  }
};


// =============================================================================
// SECTION 12 — EXPORTS (uncomment to activate)
// =============================================================================
// After running analysis, call these from the console or un-comment and re-run.
// CRS: EPSG:32637 = UTM Zone 37N (appropriate for Kenya/East Africa)

/*
// Export cumulative loss year map
Export.image.toDrive({
  image: state.annualCollection
    .map(function(img){ return img.multiply(ee.Number(img.get('year'))).rename('loss_year'); })
    .reduce(ee.Reducer.min())
    .updateMask(
      state.annualCollection
        .map(function(img){ return img.multiply(ee.Number(img.get('year'))).rename('loss_year'); })
        .reduce(ee.Reducer.max()).gt(0)
    ),
  description: 'TropiSCO_CumulativeLoss',
  folder: 'TropiSCO_Analysis',
  fileNamePrefix: 'cumulative_loss_year',
  region: state.selectedGeom,
  scale: 10, crs: 'EPSG:32637', maxPixels: 1e13
});
*/

/*
// Export forest mask (2018)
Export.image.toDrive({
  image: state.forestMaskCleaned.toFloat(),
  description: 'TropiSCO_ForestMask_2018',
  folder: 'TropiSCO_Analysis',
  fileNamePrefix: 'forest_mask_2018',
  region: state.selectedGeom,
  scale: 10, crs: 'EPSG:32637', maxPixels: 1e13
});
*/

/*
// Export annual loss area statistics as CSV
Export.table.toDrive({
  collection: state.lossAreaByYear,
  description: 'TropiSCO_AnnualLossArea',
  folder: 'TropiSCO_Analysis',
  fileNamePrefix: 'annual_loss_area_ha',
  fileFormat: 'CSV'
});
*/


// =============================================================================
// END OF SCRIPT
// =============================================================================
// WORKFLOW SUMMARY:
//   1. Pick a boundary dataset from the dropdown (top-right panel)
//   2. For multi-polygon datasets (counties, constituencies, HydroSHEDS, etc.):
//      → The full boundary layer loads on the map
//      → Click any polygon to select it as your AOI
//      → The selected polygon is highlighted in red
//   3. For Muringato Basin: auto-selected, go directly to Step 4
//   4. Click "Run Forest Loss Analysis" → the pipeline executes server-side
//   5. Results appear on the map; use sliders to explore by year / month
//
// REFINEMENT IDEAS:
//   A) Replace WorldCover with Kenya Forest Service boundaries for higher
//      local accuracy (load as an asset and use as conditionA).
//   B) Add a text input field letting users type a feature name to filter
//      the collection (e.g. type "Nairobi" to auto-select Nairobi County).
//   C) Add 7-day window detection in the monthly pipeline for true near-real-time.
//   D) Add a "Download current period" button that calls Export.image.toDrive()
//      for whichever period the slider is pointing to.
// =============================================================================
