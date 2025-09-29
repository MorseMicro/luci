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

class HaLowChannels {
	constructor(channels) {
		// shallow copy, as we want to mutate what's in the channels.
		this.channels = channels.map(c => Object.assign({}, c));
		this.channelMap = {};

		this.chznsByCountry = {};

		for (let c of this.channels) {
			this.chznsByCountry[c.country_code] ??= new Set(['current']);

			c.channelizations = new Set(c.channelizations.split(';'));
			// If 'current' is a channelization, we don't report the other
			// possible channelizations (as they're not necessary to select
			// this channel). This means that currently only AU will
			// report two channelizations (2020 and current).
			if (!c.channelizations.has('current')) {
				for (const chzn of c.channelizations) {
					this.chznsByCountry[c.country_code].add(chzn);
				}
			}
		}
	}

	getCountryCodes() {
		return new Set(this.channels.map(c => c.country_code));
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
	_setHaLowChannelMap(country_code, channelization = 'current', activeChannels = null) {
		const channels = {};

		for (const c of this.channels) {
			if (c.country_code === country_code && c.channelizations.has(channelization)) {
				if (!activeChannels || activeChannels.has(c.s1g_chan)) {
					channels[c.s1g_chan] = c;
				}
			}
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
	getMap(country_code, channelization = 'current') {
		if (!this.channelMap[country_code]?.[channelization]) {
			this._setHaLowChannelMap(country_code, channelization);
		}

		return this.channelMap[country_code][channelization];
	}

	/**
	 * Return channelizations used by channels sufficient to cover them all.
	 *
	 * NB Only consider alternate channelizations if current is NOT
	 * one of the possible channelizations. In practice, this means in
	 * the common case we report {current} as the only option, but for
	 * AU we report {current, 2020}.
	 */
	getChannelizations(country_code) {
		return Array.from(this.chznsByCountry[country_code]);
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
