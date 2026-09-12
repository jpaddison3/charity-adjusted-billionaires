# Charity-adjusted wealth methodology

The committed output is a retrospective **December 31, 2025 snapshot**, not a real-time estimate. Publication is roughly eight months after the valuation date. Inputs preserve observation, publication, retrieval, and valuation dates separately.

## Definition

For donor $d$ and snapshot $T$, charity-adjusted wealth is

$$
W_d(T) + \sum_g A_g C_{g,d}\frac{I(T)}{I(t_g)},
$$

where $W_d(T)$ is the eligible wealth observation carried unchanged to the snapshot, $A_g$ is the transfer-time dollar amount, $C_{g,d}$ is the donor's credit share, and $I$ is the saved S&P 500 cumulative total-return series. This asks what the donor's completed charitable transfers would be worth if invested in the dividend-reinvesting market series. It is not a claim about how the recipient invested the gift.

Inflation-adjusted giving is reported separately:

$$
\sum_g A_g C_{g,d}\frac{\operatorname{CPI}(T)}{\operatorname{CPI}(t_g)}.
$$

It is not added to wealth. Calculations retain JavaScript numeric precision; exported dollar values are rounded to cents. Ranking uses unrounded charity-adjusted wealth and breaks ties by donor ID.

## Dates and alignment

The transfer ledger preserves the seed date, assessed precision, and calculation date. Day-precision transfers use the supported date. A month or year uses the earlier middle UTC calendar day: `start + floor((daysInPeriod - 1) / 2)`. Unallocatable multi-year totals are excluded. Transfers after the snapshot remain visible with an `after-snapshot` exclusion reason.

Market observations are exact December 31 cumulative values from Damodaran's S&P 500 series including dividends. For a date between endpoints $a$ and $b$:

$$
I(t)=I(a)\left(\frac{I(b)}{I(a)}\right)^{(t-a)/(b-a)}.
$$

The exponent uses UTC calendar-day differences, including weekends and leap days. This is uniform compounded interpolation, not observed daily market performance. Missing endpoints or extrapolation fail generation.

CPI-U uses the gift's calendar month and December 2025 for $T$. FRED/BLS has no October 2025 observation, so the saved value is the explicitly labeled arithmetic mean of September and November: $(324.800 + 324.122)/2 = 324.461$. Every transfer using that month is labeled in the export. Any other missing month, or a missing snapshot month, aborts generation.

## Transfers and reconciliation

The raw donation loader returns one economic event with its complete credit map, source location, row locator, and semantic SHA-256 fingerprint. `data/lcb/inputs/transfers.json` gives every active seed event an inclusion decision. Missing dispositions, stale fingerprints, unknown donors, and duplicate transfer identities within a funding chain fail generation.

Only completed irrevocable personal transfers into charities, foundations, or donor-advised funds count. Pledges, downstream grants from a funded vehicle, inter-vehicle movements, political giving, and noncharitable investments do not. Excluding one donor does not redistribute their credit share. Unresolved totals are disclosed in coverage rather than added.

The material reconciliation replaced Warren Buffett's five pledge-era cumulative estimates with annual 2006–2025 share transfers, removed bidder-funded GLIDE auction proceeds, and retained distinct later supplements. Gates Foundation Trust audited fair values anchor Gates-recipient amounts; other Buffett-family foundation amounts are identified as share-ratio estimates where recipient fair value was unavailable.

For Bill and Melinda Gates, foundation inflows remain but downstream UNCF, Gavi, university, library, and Pivotal distributions were removed. The 2004 planned transfer and the inferred 2025 rounded delta are unresolved rather than counted. Filed values replace the 2017 and 2022 estimates. Four October 2024 Pivotal Schedule B transfers are separate legal transfers; the commitment remainder stays unresolved. Full arithmetic and removed records are in `data/lcb/inputs/reconciliation.json`.

## Wealth and coverage

Donor IDs join explicitly to wealth profile IDs. The preferred input is the latest dated individual observation on or before the snapshot within 2025, carried forward unchanged and with its lag disclosed. No S&P growth is applied to wealth. Post-snapshot observations and undated donor-frontmatter `netWorth` values are never used.

Forbes's March 7, 2025 list supplies most observations; the saved CSV is identified as an independent transcription and paired with Forbes's official date and methodology. Dated alternatives cover four people absent from that list. Dustin Moskovitz/Cari Tuna, Steve/Connie Ballmer, and John/Laura Arnold are unranked because the evidence identifies shared wealth pools without defensible individual allocations. Missing or unusable wealth, and matched donors without supported giving, stay null and unranked rather than becoming zero.

All 78 histories are marked partial: the decision ledger covers every seed event, but deeper source reconciliation was intentionally bounded to material overlap risks. `coverage.json` reports active and excluded files, every included/excluded event, future transfers, wealth status, and unresolved balances.

## Reproducing the snapshot

No network access is used during generation.

1. Install locked dependencies with `npm ci`.
2. Run `npm run generate-data` to validate the content dataset.
3. Run `npm run generate-lcb-data` to write the four committed exports.
4. Run `npm run check-lcb-data` to regenerate in memory and byte-compare every export.
5. Run the focused tests, lint, coverage suite, and build as described in the repository README.

When donation content changes, the transfer fingerprint changes; update its explicit ledger disposition before regenerating. When a saved raw source changes, update its recorded SHA-256 and provenance deliberately.
