/* Helpers for reading halow channel info from channels.csv.
 *
 * We currently don't just use iwinfo because:
 *  - iwinfo freqlist doesn't have bandwidth information
 *  - iwinfo freqlist can only give info about the current region
 *    (and currently our frontend auto-updates when the region is changed
 *    before its persisted)
 */
'use strict';
'require request';

// Driver doesn't support the same set of country codes as a regulatory information
// (notably, EU is not split out into individual countries in the driver).
const DRIVER_COUNTRIES = new Set(['US', 'AU', 'NZ', 'EU', 'IN', 'JP', 'KR', 'SG']);

let loadChannelMapPromise;
async function loadChannelMap() {
	if (!loadChannelMapPromise) {
		loadChannelMapPromise = callLoadChannelMap();
	}

	return loadChannelMapPromise;
}

async function callLoadChannelMap() {
	const channelsResponse = await request.get(`/halow-channels.csv?v=${L.env.resource_version}`, {cache: true});
	if (!channelsResponse.ok) {
		L.error(`Unable to load channel map: {response.statusText}`);
	}

	const [header, ...data] = channelsResponse.text().trim().split(/[\r\n]+/).map(line => line.split(','));

	const channels = data.map(channel => channel.reduce((channel_obj, val, i) => {
		channel_obj[header[i]] = val;
		return channel_obj;
	}, {}));

	const availableChannels = channels.filter(channel => DRIVER_COUNTRIES.has(channel.country_code) && channel.usable_banff_c == 1);
	const channelMap = {};
	for (const channel of availableChannels) {
		const {country_code, s1g_chan} = channel;
		channelMap[country_code] ??= {};
		channelMap[country_code][s1g_chan] = channel;
	}

	return channelMap;
}

return L.Class.extend({
	loadChannelMap,
});