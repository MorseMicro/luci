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

	const channelMap = {};
	for (let channel of channels) {
		const {country_code, s1g_chan} = channel;
		channelMap[country_code] ??= {};
		channelMap[country_code][s1g_chan] = channel;
	}

	return channelMap;
}

return L.Class.extend({
	loadChannelMap,
});
