# Beelove — strategy and sentinel hive notes (5 Oct 2026)

Saved at the end of our session so we can continue from here.
Related: the positioning brief "Beelove positioning brief" (Oct 5, 2026, @Jonesmus) and the Asana project
"Beelove Strategy & Intelligence 2026–2030".

## 1. Positioning (agreed)
**"We don't just sell hives — we help you fill them."** (Kiswahili: *Hatuuzi mizinga tu — tunakusaidia ijae nyuki.*)
The bottleneck in African beekeeping is empty hives, not hives. The brief and Claude's independent analysis reached
the same core idea. The farmer app and the stock app stay **independent**.

## 2. Five additions that turn the position into a tech lead
1. **Pre-registered swarm forecasts.** Before each swarm season, freeze and publish (dated) the swarm-window warning per
   ward; after the season, score it against swarm arrivals recorded in the app ("our alerts came 2–6 weeks before X% of
   recorded arrivals"). A public track record is the moat. The untested link is rain → swarm arrival: test it this season.
2. **Sentinel hives against the biggest losses** (theft and drought rank first): weighing hives that send an SMS on a
   sudden night-time weight drop (theft), flag absconding, and measure nectar flow / dearth (ground truth for the
   satellite model). Makes "Hive Sensors – Soon" on the website real.
3. **Monthly dryland colony index** per ward (occupancy, losses and why, swarms arrived), COLOSS-compatible definitions,
   published as the county bulletin. Only totals per ward; individual records stay private.
4. **Results-based contracts:** institutions pay per hive still occupied after 6 months. Start with an NGO (faster
   payment than a county).
5. **Fish, after Kigali:** "We don't just sell fingerlings — we help you harvest them." Overnight low-oxygen warnings
   from the weather forecast, survival and cost-per-kg records.

### Before the Claude credit expires (Nov 5)
1. **Oct 9 — video script** (90 s + three 20 s cuts, English and Kiswahili) — assigned to Claude in the brief's timeline.
2. **Farmer app check-in, before public launch:** swarm arrival date, "baited this month? Y/N", theft as a loss reason.
3. **This month:** freeze this season's ward warnings in a dated file (start of the track record).
4. **After Kigali:** pilot 3–5 sentinel hives.

## 3. Sentinel hive — how it works
- Weighing platform (4 load cells) under the hive → HX711 amplifier → LilyGO board (ESP32 + 4G modem) wakes hourly,
  weighs, sleeps; sends readings 2–4×/day to a Google Sheet ("sentinel" tab); SMS immediately on a sudden drop.
- Theft: drop > ~5 kg at night → SMS. Absconding: sudden 1–2 kg daytime drop that isn't a harvest.
- Calibrate once with a known weight (full 20 L jerry can ≈ 20 kg).
- **Start now, no electronics:** 100 kg luggage scale, lift each end of the hive, add the two readings ≈ total weight.
  Weigh the same 5–10 hives weekly at the same time of day.
- **Buildable yourself** (beginner–intermediate). Avoid soldering with screw-terminal parts and Wago lever connectors.
  Tools: laptop + USB cable, screwdrivers, wire strippers, multimeter (~KSh 1,000), drill; optional soldering iron
  (KSh 1,500–2,500). First unit about a weekend, then 2–3 h each. Build the first one yourself; a fundi or trainee
  can build the rest from the guide.

### Parts and where to buy (prices found online 5 Oct 2026 — check before buying)
| Part | Where | Approx. KSh |
|---|---|---|
| **LilyGO T-A7670E or T-A7670G, R2** (not "SA"; GPS not needed) — order 2 | [Juakali Products (Kenya)](https://imports.juakaliproducts.co.ke/shop/consumer-electronics-kenya-sa/lilygo-ttgo-t-a7670g-e-sa-r2-4g-development-board-lte-cat1-sim-module-esp32-support-gsm-gprs-edge-tf-card-a7670g-a7670e-a7670sa), [AliExpress LilyGO store](https://www.aliexpress.com/item/1005003036514769.html) (2–4 weeks, KRA duty may apply), [lilygo.cc](https://lilygo.cc/en-us/products/t-sim-a7670e) | 2,000–4,000 |
| 4 × **50 kg body (half-bridge) load cells** — not 1/5 kg bar type | [Nerokas](https://store.nerokas.co.ke/index.php?route=product%2Fproduct&product_id=1282) (Thika), AskElectronics (Madaraka, Nairobi) | ~300 each |
| HX711 amplifier | Nerokas, [Pixel Electric](https://www.pixelelectric.com/sensors/load-pressure-flow-vibration/load-pressure-force-flex-sensor/hx711-load-cell-amplifier/) | ~150 |
| 2 × 18650 batteries (from a shop — fakes are common), 6 V 1–2 W solar panel, DS18B20 waterproof temperature probe, Wago connectors, IP65 box + cable glands | Pixel Electric, electronics/hardware shops | ~2,000–2,500 |
| Platform (steel angle or treated timber, plate, bolts) | Own workshop | 800–1,500 |
| Safaricom SIM with small data bundle | | ~50–100 / month |
| **Total first unit** | | **≈ 6,000 – 9,500** |

Cheaper option: plain ESP32 + SIM800L (≈ KSh 4,500–6,500 total) — but SIM800L is 2G only; check 2G coverage first.

### The box
1. **First unit:** ready-made IP65 ABS junction box (~150 × 110 × 70 mm, KSh 400–800); step-drill the holes, cable
   glands, internal mounting plate, Beelove label.
2. **Custom 3D-printed box:** Claude designs it (STL) to fit the exact board, batteries and HX711, with screw tabs and
   the Beelove logo. Print in **PETG or ASA, never PLA**. Nairobi printers: [Cubic3D](https://cubic3d.co.ke/),
   [SatoPrints](https://www.satoprints.co.ke/), [Ultra Red Technologies](https://ultrared.biz/),
   [SD Creative KE](https://sdcreativeke.com/3d-printing). ~KSh 1,000–2,500 each (get a quote).
3. **Production:** lockable steel compartment welded under the platform by the workshop, painted Beelove yellow, with a
   printed tray inside — hidden and hard to steal. Claude provides a dimensioned drawing.
- Always: cable entries at the bottom only, drip loops, a breather vent (~KSh 200) + silica gel, mounted in shade;
  solar panel on a bracket facing roughly north, slightly tilted.

## 4. Next steps (to continue)
- [ ] Order the LilyGO (2 boards) — longest lead time.
- [ ] Buy the local parts while waiting; start the luggage-scale weighing on 5–10 hives.
- [ ] Claude: video script (due Oct 9).
- [ ] Claude: farmer app check-in fields (swarm arrival date, baited Y/N, theft as a loss reason).
- [ ] Claude: freeze this season's ward warnings in a dated file.
- [ ] Claude, once the board arrives: shopping list + no-solder build guide, firmware, Google Sheet script + SMS alert,
      3D-printable box (STL) and workshop drawing for the steel compartment.

## Open items from the stock app (Beelove Stock)
- Upload the fish shop page to set fingerling / table-fish prices.
- Optionally merge branch `claude/hello-mpfkax` into `main` with a pull request.
