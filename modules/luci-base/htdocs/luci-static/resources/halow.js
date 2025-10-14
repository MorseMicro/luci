/* Helpers for reading halow channel info from channels.csv.
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

			if (activeChannels && !activeChannels.has(c.s1g_chan)) {
				continue;
			}

			channels[c.s1g_chan] = c;
		}

		// Determine which primary channel indices point to unblocked channels.
		const allowedKhz = new Set(Object.values(channels)
			.map(ch => Math.round(ch.centre_freq_mhz * 1000)));

		for (const c of Object.values(channels)) {
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
						(c[`prim_chan_indices_for_${width}MHz`] ??= []).push(index);
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

let getCSVPromise;
async function loadChannels() {
	if (!getCSVPromise) {
		getCSVPromise = getCSV();
	}

	return new HaLowChannels(await getCSVPromise);
}

/**
 * Request the halow-channels.csv file.
 *
 * The header is used to construct each line in object format.
 */
async function getCSV() {
	const resp = await request.get(`/halow-channels.csv?v=${L.env.resource_version}`, {cache: true});
	if (!resp.ok) {
		L.error(`Unable to load channel map: ${resp.statusText}`);
	}

	const [header, ...data] = (await resp.text()).trim().split(/[\r\n]+/).map(line => line.split(','));

	return data.map(channel => channel.reduce((channel_obj, val, i) => {
		channel_obj[header[i]] = val;
		return channel_obj;
	}, {}));
}

return L.Class.extend({
	loadChannels,
});
