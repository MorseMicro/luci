/* Helpers for reading halow channel info from the morse-regdb csvs.
 *
 * channels.csv is the regulatory data whereas s1g_opclasses.csv is the operating 
 * class table from the spec, which is only used in the test driver mode.
 *
 * We currently don't just use iwinfo because:
 *  - iwinfo freqlist doesn't have bandwidth information
 *  - iwinfo freqlist only gives info about the current region
 *    and channelization (and currently our frontend auto-updates
 *    when the region is changed before its persisted)
 */
'use strict';
'require request';

const CHZN_NAMES = {
	"80211_revmf": "IEEE 802.11-REVmf",
	"80211_2020": "IEEE 802.11-2020",
	"80211_2024": "IEEE 802.11-2024",
};

/* These countries are restricted from using mesh modes. */
 const DISABLED_MESH_COUNTRIES = new Set([
	'EU',
	'GB',
 ]);

function isDisabledMeshCountry(code) {
	return DISABLED_MESH_COUNTRIES.has(code);
}

class HaLowChannels {
	constructor(channels) {
		// shallow copy, as we want to mutate what's in the channels.
		this.channels = channels.map(c => Object.assign({}, c));
		this.channelMap = {};

		this.countryInfo = {};

		for (let c of this.channels) {
			this.countryInfo[c.country_code] ??= {
				country_code: c.country_code,
				country: c.country,
				channelizations: {},
			};

			c.channelizations = new Set(c.channelizations ? c.channelizations.split(';') : []);
			c.default_channelization = c.default_channelization === 'True';

			// If channelizations is empty, this country ignores channelization_scheme
			// as it only has one channelization. This means we don't
			// need to show any dropdown (as they're not necessary to select
			// this channel). Currently only AU will report multiple channelizations.
			if (!c.channelizations) {
				continue;
			}

			// Attempt to figure out the available channelizations from the rows.
			for (const chzn of c.channelizations) {
				this.countryInfo[c.country_code].channelizations[chzn] ??= {
					fullname: CHZN_NAMES[chzn] || chzn,
					codename: chzn,
					default: true,
					channelCount: 0,
				};

				this.countryInfo[c.country_code].channelizations[chzn].channelCount += 1;

				if (!c.default_channelization) {
					// i.e. if any channel in the channelization is not a 'default'
					// channel, this must not be a default channelization option.
					this.countryInfo[c.country_code].channelizations[chzn].default = false;
				}
			}
		}

		// Determine which channelization is 'really' the default, based on which
		// default has the highest channel count. All others are _not_ the default.
		for (const info of Object.values(this.countryInfo)) {
			if (Object.keys(info.channelizations).length === 0) {
				continue;
			}

			const maxDefaultCount = Math.max(...Object.values(info.channelizations)
				.filter(chzn => chzn.default).map(chzn => chzn.channelCount));
			for (const chzn of Object.values(info.channelizations)) {
				if (chzn.channelCount != maxDefaultCount) {
					chzn.default = false;
				}
			}
		}
	}

	getCountryCodes() {
		return new Set(this.channels.map(c => c.country_code));
	}

	getCountryInfo() {
		return this.countryInfo;
	}

	/**
	 * Remove any channels not in the activeChannels set.
	 *
	 * This lets us present only valid channels, at least in the current region.
	 */
	restrict(country_code, channelization, activeChannels) {
		// Recalculate the channel map so we can fix up the primary
		// channel index allow lists as well.
		this._setHaLowChannelMap(country_code, channelization, activeChannels);
	}

	/**
	 * Cache the channel list for a particular country/channelization.
	 *
	 * Also restrict channels based on activeChannels if specified, and add info
	 * about the available primary channel indices based on the current active channels.
	 */
	_setHaLowChannelMap(country_code, channelization = null, activeChannels = null) {
		if (!channelization) {
			// Collapse undefined/"" to null.
			channelization = null;
		}

		const channels = {};

		for (const c of this.channels) {
			if (c.country_code !== country_code) {
				continue;
			}

			if (c.channelizations.size !== 0) {
				if (channelization) {
					if (!c.channelizations.has(channelization)) {
						continue;
					}
				} else if (!c.default_channelization) {
					continue;
				}
			}

			if (activeChannels && !activeChannels.has(Number(c.s1g_chan))) {
				continue;
			}

			channels[c.s1g_chan] = c;
		}

		// Determine which primary channel indices point to unblocked channels.
		const allowedKhz = new Set(Object.values(channels)
			.map(ch => Math.round(ch.centre_freq_mhz * 1000)));

		for (const c of Object.values(channels)) {
			// This channel might be used by other channelizations, or we may have
			// called restrict() again, so make sure to recalculate from scratch.
			c.prim_chan_indices_allowed = {};

			for (let width = 1; width <= Math.min(2, c.bw); ++width) {
				for (let index = 0; index < Number(c.bw); ++index) {
					let offsetMhz;
					if (width === 2) {
						offsetMhz = -c.bw / 2 + 1 + Math.floor(index / 2) * 2;
					} else {  // primChanWidth === '1'
						offsetMhz = -c.bw / 2 + 0.5 + index;
					}
					const freqKhz = Math.round(1000 * (Number(c.centre_freq_mhz) + offsetMhz));
					if (allowedKhz.has(freqKhz)) {
						(c.prim_chan_indices_allowed[width] ??= []).push(index);
					}
				}
			}
		}

		(this.channelMap[country_code] ??= {})[channelization] = 
			Object.keys(channels).length > 0 ? channels : null;
	}

	/**
	 * Get a map of channel->chanInfo for this country_code + channelization.
	 */
	getMap(country_code, channelization = null) {
		if (!channelization) {
			// Collapse undefined/"" to null.
			channelization = null;
		}

		if (!this.channelMap[country_code]?.[channelization]) {
			this._setHaLowChannelMap(country_code, channelization);
		}

		return this.channelMap[country_code][channelization];
	}

	/**
	 * Return channelizations used by this country.
	 *
	 * If country has no specific channelization info, returns
	 * an empty list.
	 *
	 * @returns {array} [{default, fullname, codename}]
	 */
	getChannelizations(country_code) {
		return Object.values(this.countryInfo[country_code]?.channelizations ?? {});
	}

	getDefaultChannelization(country_code) {
		return this.getChannelizations(country_code).filter(chzn => chzn.default)[0];
	}
}

/**
 * The S1G channels grouped by global operating class (IEEE 802.11 2024).
 */
class S1GOpClasses {
	constructor(rows) {
		// bw -> global op_class -> {op_class, regions, channels: {chan: chanInfo}}
		this.opClassMap = {};

		for (const row of rows) {
			const opClassInfo = ((this.opClassMap[row.bw] ??= {})[row.global_op_class] ??= {
				op_class: row.global_op_class,
				regions: new Set(),
				channels: {},
			});

			opClassInfo.regions.add(row.region);

			opClassInfo.channels[row.s1g_chan] = {
				s1g_chan: row.s1g_chan,
				centre_freq_mhz: row.centre_freq_mhz,
				freq_khz: Math.round(Number(row.centre_freq_mhz) * 1000),
			};
		}
	}

	/**
	 * Get the operating classes usable at this bandwidth, in operating class order.
	 *
	 * @returns {array} [{op_class, regions, channels}]
	 */
	getOpClasses(bw) {
		return Object.values(this.opClassMap[bw] ?? {})
			.sort((a, b) => Number(a.op_class) - Number(b.op_class));
	}

	/**
	 * Get the channels in an operating class, in channel number order.
	 *
	 * @returns {array} [{s1g_chan, centre_freq_mhz, freq_khz}]
	 */
	getChannels(bw, opClass) {
		return Object.values(this.opClassMap[bw]?.[opClass]?.channels ?? {})
			.sort((a, b) => Number(a.s1g_chan) - Number(b.s1g_chan));
	}

	/**
	 * Get the centre frequencies at the edges of an operating class as [first, last] in MHz.
	 *
	 * The channels of a class all share its starting frequency, so channel order is
	 * frequency order.
	 */
	getFreqRangeMhz(bw, opClass) {
		const channels = this.getChannels(bw, opClass);

		return [ channels[0]?.centre_freq_mhz, channels[channels.length - 1]?.centre_freq_mhz ];
	}

	/**
	 * Get the centre frequency in kHz for a channel, or null if it's not in the table.
	 */
	getFreqKhz(bw, opClass, chan) {
		return this.opClassMap[bw]?.[opClass]?.channels?.[chan]?.freq_khz ?? null;
	}
}

async function loadChannels() {
	return new HaLowChannels(await getCSV('halow-channels.csv'));
}

async function loadOpClasses() {
	return new S1GOpClasses(await getCSV('halow-opclasses.csv'));
}

const csvPromises = {};

/**
 * Request one of the morse-regdb csv files (exposed in /www by the morse-regdb package).
 *
 * The header is used to construct each line in object format.
 */
async function getCSV(filename) {
	csvPromises[filename] ??= (async () => {
		const resp = await request.get(`/${filename}?v=${L.env.resource_version}`, {cache: true});
		if (!resp.ok) {
			L.error(`Unable to load ${filename}: ${resp.statusText}`);
		}

		const [header, ...data] = (await resp.text()).trim().split(/[\r\n]+/).map(line => line.split(','));

		return data.map(row => row.reduce((row_obj, val, i) => {
			row_obj[header[i]] = val;
			return row_obj;
		}, {}));
	})();

	return csvPromises[filename];
}

return L.Class.extend({
	loadChannels,
	loadOpClasses,
	isDisabledMeshCountry
});
