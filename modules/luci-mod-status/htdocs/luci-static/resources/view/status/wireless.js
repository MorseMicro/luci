'use strict';
'require view';
'require poll';
'require request';
'require ui';
'require dom';
'require rpc';
'require network';

const callLuciRealtimeStats = rpc.declare({
	object: 'luci',
	method: 'getRealtimeStats',
	params: [ 'mode', 'device' ],
	expect: { result: [] }
});

const graphPolls = [], pollInterval = 3;

Math.log2 = Math.log2 || function(x) { return Math.log(x) * Math.LOG2E; };

function rate(n, br) {
	n = (n || 0).toFixed(2);
	return [ '%1024.2mbit/s'.format(n * 8), br ? '<br>' : ' ', '(%1024.2mB/s)'.format(n) ]
}

return view.extend({

	load: function() {
		return Promise.all([
			network.getWifiDevices().then(function(radios) {
				var tasks = [], all_networks = [];

				for (const radio of radios) {
					if (radio.isDisabled()) continue;
					tasks.push(radio.getWifiNetworks().then((networks) => {
						for (const net of networks) {
							if (net.isDisabled()) continue;
							all_networks.push(net);
						}
					}));
				}

				return Promise.all(tasks).then(() => {
					return all_networks;
				});
			}),
			this.loadSVG(L.resource('svg/wireless.svg')),
			this.loadSVG(L.resource('svg/bandwidth.svg')),
			this.loadSVG(L.resource('svg/wifirate.svg')),
			this.loadSVG(L.resource('svg/mcs.svg'))
		]);
	},
	isRadios1g: function(radio)
	{
		if (radio._ubusdata.dev !== undefined) {
			return radio._ubusdata.dev.config.band == 's1g';
		} else {
			return false;
		}
	},

	updateGraph: function(ifname, mode, svg, lines, cb) {
		var G = svg.firstElementChild;

		const view = document.querySelector('#view');

		const width  = view.offsetWidth - 2;
		const height = 300 - 2;
		const step   = 5;

		const data_wanted = Math.floor(width / step);

		const data_values = [],
		    line_elements = [];

		for (const line of lines)
			if (line)
				data_values.push([]);

		const info = {
			line_current: [],
			line_average: [],
			line_peak:    []
		};

		/* prefill datasets */
		for (let i = 0; i < data_values.length; i++)
			for (let j = 0; j < data_wanted; j++)
					data_values[i][j] = 0;

		/* plot horizontal time interval lines */
		for (let i = width % (step * 60); i < width; i += step * 60) {
			const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttribute('x1', i);
			line.setAttribute('y1', 0);
			line.setAttribute('x2', i);
			line.setAttribute('y2', '100%');
			line.setAttribute('style', 'stroke:black;stroke-width:0.1');

			const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
			text.setAttribute('x', i + 5);
			text.setAttribute('y', 15);
			text.setAttribute('style', 'fill:#eee; font-size:9pt; font-family:sans-serif; text-shadow:1px 1px 1px #000');
			text.appendChild(document.createTextNode(Math.round((width - i) / step / 60) + 'm'));

			G.appendChild(line);
			G.appendChild(text);
		}

		info.interval = pollInterval;
		info.timeframe = data_wanted / 60;

		graphPolls.push({
			ifname: ifname,
			mode: mode,
			svg:    svg,
			lines:  lines,
			cb:     cb,
			info:   info,
			width:  width,
			height: height,
			step:   step,
			values: data_values,
			timestamp: 0,
			fill: 1
		});
	},

	pollData() {
		poll.add(L.bind(function() {
			const tasks = [];

			for (var i = 0; i < graphPolls.length; i++) {
				var ctx = graphPolls[i];
				tasks.push(L.resolveDefault(callLuciRealtimeStats(ctx.mode, ctx.ifname), []));
			}

			return Promise.all(tasks).then(L.bind(function(datasets) {
				for (let gi = 0; gi < graphPolls.length; gi++) {
					const ctx = graphPolls[gi];
					const data = datasets[gi];
					const values = ctx.values;
					const lines = ctx.lines;
					const info = ctx.info;

					let data_scale = 0;
					const data_wanted = Math.floor(ctx.width / ctx.step);
					let last_timestamp = NaN;

					for (let i = 0, di = 0; di < lines.length; di++) {
						if (lines[di] == null)
							continue;

						const multiply = (lines[di].multiply != null) ? lines[di].multiply : 1;
						const offset = (lines[di].offset != null) ? lines[di].offset : 0;

						for (let j = ctx.timestamp ? 0 : 1; j < data.length; j++) {
							/* skip overlapping entries */
							if (data[j][0] <= ctx.timestamp)
								continue;

							if (i == 0) {
								ctx.fill++;
								last_timestamp = data[j][0];
							}

							if (lines[di].counter) {
								/* normalize difference against time interval */
								if (j > 0) {
									var time_delta = data[j][0] - data[j - 1][0];
									if (time_delta) {
										info.line_current[i] = (data[j][di + 1] * multiply - data[j - 1][di + 1] * multiply) / time_delta;
										info.line_current[i] -= Math.min(info.line_current[i], offset);
										values[i].push(info.line_current[i]);
									}
								}
							}
							else {

								info.line_current[i] = data[j][di + 1] * multiply;
								info.line_current[i] -= Math.min(info.line_current[i], offset);
								values[i].push(info.line_current[i]);
							}
						}

						i++;
					}

					/* cut off outdated entries */
					ctx.fill = Math.min(ctx.fill, data_wanted);

					for (let i = 0; i < values.length; i++) {
						const len = values[i].length;
						values[i] = values[i].slice(len - data_wanted, len);

						/* find peaks, averages */
						info.line_peak[i] = NaN;
						info.line_average[i] = 0;

						for (let j = 0; j < values[i].length; j++) {
							info.line_peak[i] = isNaN(info.line_peak[i]) ? values[i][j] : Math.max(info.line_peak[i], values[i][j]);
							info.line_average[i] += values[i][j];
						}

						info.line_average[i] = info.line_average[i] / ctx.fill;
					}

					info.peak = Math.max.apply(Math, info.line_peak);

					/* remember current timestamp, calculate horizontal scale */
					if (!isNaN(last_timestamp))
						ctx.timestamp = last_timestamp;

					const size = Math.floor(Math.log2(info.peak));
					const div = Math.pow(2, size - (size % 10));
					const p_o_d = info.peak / div;
					const mult = (p_o_d < 5) ? 2 : ((p_o_d < 50) ? 10 : ((p_o_d < 500) ? 100 : 1000));

					info.peak = info.peak + (mult * div) - (info.peak % (mult * div));

					data_scale = ctx.height / info.peak;

					/* plot data */
					for (let i = 0, di = 0; di < lines.length; di++) {
						if (lines[di] == null)
							continue;

						const el = ctx.svg.firstElementChild.getElementById(lines[di].line);
						let pt = `0,${ctx.height}`;
						let y = 0;

						if (!el)
							continue;

						for (let j = 0; j < values[i].length; j++) {
							const x = j * ctx.step;

							y = ctx.height - Math.floor(values[i][j] * data_scale);
							//y -= Math.floor(y % (1 / data_scale));

							y = isNaN(y) ? ctx.height : y;

							pt += ` ${x},${y}`;
						}

						pt += ` ${ctx.width},${y} ${ctx.width},${ctx.height}`;

						el.setAttribute('points', pt);

						i++;
					}

					info.label_25 = 0.25 * info.peak;
					info.label_50 = 0.50 * info.peak;
					info.label_75 = 0.75 * info.peak;

					if (typeof(ctx.cb) == 'function')
						ctx.cb(ctx.svg, info);
				}
			}, this));
		}, this), pollInterval);
	},

	loadSVG(src) {
		return request.get(src).then(function(response) {
			if (!response.ok)
				throw new Error(response.statusText);

			return E('div', {
				'style': 'width:100%;height:300px;border:1px solid #000;background:#fff'
			}, E(response.text()));
		});
	},

	render: function([wifidevs, ...svgs]) {
		var v = E('div', {}, E('div'));

		for (var i = 0; i < wifidevs.length; i++) {
			var ifname = wifidevs[i].getIfname();
			var is_s1g = this.isRadios1g(wifidevs[i]);
			var mode = "wireless";
			if (is_s1g)
				mode = "interface";

			if (!ifname)
				continue;

			const [wireless_svg, bandwidth_svg, wifirate_svg, mcs_svg] = svgs.map(svg => svg.cloneNode(true));

			v.firstElementChild.appendChild(E('div', { 'data-tab': ifname, 'data-tab-title': ifname }, [
				wireless_svg,
				E('div', { 'class': 'right' }, E('small', { 'id': 'scale' }, '-')),
				E('br'),

				E('table', { 'class': 'table', 'style': 'width:100%;table-layout:fixed' }, [
					E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td right top' }, E('strong', { 'style': 'border-bottom:2px solid blue' }, [ _('Signal:') ])),
						E('td', { 'class': 'td', 'id': 'rssi_bw_cur' }, [ '0 ' + _('dBm') ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [ _('Average:') ])),
						E('td', { 'class': 'td', 'id': 'rssi_bw_avg' }, [ '0 ' + _('dBm') ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [ _('Peak:') ])),
						E('td', { 'class': 'td', 'id': 'rssi_bw_peak' }, [ '0 ' + _('dBm') ])
					]),
					E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td right top' }, E('strong', { 'style': 'border-bottom:2px solid red' }, [ _('Noise:') ])),
						E('td', { 'class': 'td', 'id': 'noise_bw_cur' }, [ '0 ' + _('dBm') ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [ _('Average:') ])),
						E('td', { 'class': 'td', 'id': 'noise_bw_avg' }, [ '0 ' + _('dBm') ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [ _('Peak:') ])),
						E('td', { 'class': 'td', 'id': 'noise_bw_peak' }, [ '0 ' + _('dBm') ])
					])
				]),
				E('br'),

				is_s1g? bandwidth_svg:wifirate_svg,
                E('div', { 'class': 'right' }, E('small', { 'id': 'scale2' }, '-')),
                E('br'),

				is_s1g? E('table', { 'class': 'table', 'style': 'width:100%;table-layout:fixed' }, [
					E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td right top' }, E('strong', { 'style': 'border-bottom:2px solid blue' }, [_('Inbound:')])),
						E('td', { 'class': 'td', 'id': 'rx_bw_cur' }, [ '0 bit/s'  ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [_('Average:')])),
						E('td', { 'class': 'td', 'id': 'rx_bw_avg' }, [ '0 bit/s' ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [_('Peak:')])),
						E('td', { 'class': 'td', 'id': 'rx_bw_peak' }, [ '0 bit/s' ])
					]),
					E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td right top' }, E('strong', { 'style': 'border-bottom:2px solid green' }, [_('Outbound:')])),
						E('td', { 'class': 'td', 'id': 'tx_bw_cur' }, [ '0 bit/s' ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [_('Average:')])),
						E('td', { 'class': 'td', 'id': 'tx_bw_avg' }, [ '0 bit/s' ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [_('Peak:')])),
						E('td', { 'class': 'td', 'id': 'tx_bw_peak' }, [ '0 bit/s' ])
					])
				]):
				E('table', { 'class': 'table', 'style': 'width:100%;table-layout:fixed' }, [
					E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td right top' }, E('strong', { 'style': 'border-bottom:2px solid green' }, [ _('Phy Rate:') ])),
						E('td', { 'class': 'td', 'id': 'rate_bw_cur' }, [ '0 Mbit/s' ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [ _('Average:') ])),
						E('td', { 'class': 'td', 'id': 'rate_bw_avg' }, [ '0 Mbit/s' ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [ _('Peak:') ])),
						E('td', { 'class': 'td', 'id': 'rate_bw_peak' }, [ '0 Mbit/s' ])
					])
				]),
				E('br'),

				mcs_svg,
				E('div', { 'class': 'right' }, E('small', { 'id': 'scale3' }, '-')),
				E('br'),

				E('table', { 'class': 'table', 'style': 'width:100%;table-layout:fixed' }, [
					E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td right top' }, E('strong', { 'style': 'border-bottom:2px solid blue' }, [ _('Max RX MCS Index:') ])),
						E('td', { 'class': 'td', 'id': 'mcs_rx_cur' }, [ '0' ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [ _('') ])),
						E('td', { 'class': 'td' }, []),

						E('td', { 'class': 'td right top' }, E('strong', {}, [ _('Peak:') ])),
						E('td', { 'class': 'td', 'id': 'mcs_rx_peak' }, [ '0']),
					]),
					E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td right top' }, E('strong', { 'style': 'border-bottom:2px solid green' }, [ _('Max TX MCS Index:') ])),
						E('td', { 'class': 'td', 'id': 'mcs_tx_cur' }, [ '0' ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [ _('') ])),
						E('td', { 'class': 'td'}, [ ]),

						E('td', { 'class': 'td right top' }, E('strong', {}, [ _('Peak:') ])),
						E('td', { 'class': 'td', 'id': 'mcs_tx_peak' }, [ '0' ]),
					])
				]),
				E('br'),
			]));

			this.updateGraph(ifname, 'wireless', wireless_svg, [ null, { line: 'rssi', offset: 155 }, { line: 'noise', offset: 155 } ],function(svg, info) {
				var G = svg.firstElementChild, tab = svg.parentNode;

				G.getElementById('label_25').firstChild.data = '%d %s'.format(info.label_25 - 100, _('dBm'));
				G.getElementById('label_50').firstChild.data = '%d %s'.format(info.label_50 - 100, _('dBm'));
				G.getElementById('label_75').firstChild.data = '%d %s'.format(info.label_75 - 100, _('dBm'));

				tab.querySelector('#scale').firstChild.data = _('(%d minute window, %d second interval)').format(info.timeframe, info.interval);

				tab.querySelector('#rssi_bw_cur').firstChild.data = '%d %s'.format(info.line_current[0] - 100, _('dBm'));
				tab.querySelector('#rssi_bw_avg').firstChild.data = '%d %s'.format(info.line_average[0] - 100, _('dBm'));
				tab.querySelector('#rssi_bw_peak').firstChild.data = '%d %s'.format(info.line_peak[0] - 100, _('dBm'));

				tab.querySelector('#noise_bw_cur').firstChild.data = '%d %s'.format(info.line_current[1] - 100, _('dBm'));
				tab.querySelector('#noise_bw_avg').firstChild.data = '%d %s'.format(info.line_average[1] - 100, _('dBm'));
				tab.querySelector('#noise_bw_peak').firstChild.data = '%d %s'.format(info.line_peak[1] - 100, _('dBm'));
			});

			if (is_s1g)
				this.updateGraph(ifname, mode, bandwidth_svg, [{ line: 'rx', counter: true }, null, { line: 'tx', counter: true }], function (svg, info) {
					var G = svg.firstElementChild, tab = svg.parentNode;

					G.getElementById('label_25').innerHTML = rate(info.label_25, true).join('');
					G.getElementById('label_50').innerHTML = rate(info.label_50, true).join('');
					G.getElementById('label_75').innerHTML = rate(info.label_75, true).join('');

					tab.querySelector('#scale').firstChild.data = _('(%d minute window, %d second interval)').format(info.timeframe, info.interval);

					tab.querySelector('#rx_bw_cur').innerHTML = rate(info.line_current[0], true).join('');
					tab.querySelector('#rx_bw_avg').innerHTML = rate(info.line_average[0], true).join('');
					tab.querySelector('#rx_bw_peak').innerHTML = rate(info.line_peak[0], true).join('');

					tab.querySelector('#tx_bw_cur').innerHTML = rate(info.line_current[1], true).join('');
					tab.querySelector('#tx_bw_avg').innerHTML = rate(info.line_average[1], true).join('');
					tab.querySelector('#tx_bw_peak').innerHTML = rate(info.line_peak[1], true).join('');
				});
			else
				this.updateGraph(ifname, mode, wifirate_svg, [{ line: 'rate', multiply: 0.001 }], function (svg, info) {
					var G = svg.firstElementChild, tab = svg.parentNode;

					G.getElementById('label_25').firstChild.data = '%.2f %s'.format(info.label_25, _('Mbit/s'));
					G.getElementById('label_50').firstChild.data = '%.2f %s'.format(info.label_50, _('Mbit/s'));
					G.getElementById('label_75').firstChild.data = '%.2f %s'.format(info.label_75, _('Mbit/s'));

					tab.querySelector('#scale2').firstChild.data = _('(%d minute window, %d second interval)').format(info.timeframe, info.interval);

					tab.querySelector('#rate_bw_cur').firstChild.data = '%d %s'.format(info.line_current[0], _('Mbit/s'));
					tab.querySelector('#rate_bw_avg').firstChild.data = '%d %s'.format(info.line_average[0], _('Mbit/s'));
					tab.querySelector('#rate_bw_peak').firstChild.data = '%d %s'.format(info.line_peak[0], _('Mbit/s'));
				});

			this.updateGraph(ifname, 'wireless', mcs_svg, [null, null, null, { line: 'mcs_rx' }, { line: 'mcs_tx' }], function(svg, info) {
				var G = svg.firstElementChild, tab = svg.parentNode;

				G.getElementById('label_25').firstChild.data = '%d'.format(info.label_25);
				G.getElementById('label_50').firstChild.data = '%d'.format(info.label_50);
				G.getElementById('label_75').firstChild.data = '%d'.format(info.label_75);

				tab.querySelector('#scale').firstChild.data = _('(%d minute window, %d second interval)').format(info.timeframe, info.interval);

				tab.querySelector('#mcs_rx_cur').firstChild.data = '%d'.format(info.line_current[0]);
				tab.querySelector('#mcs_rx_peak').firstChild.data = '%d'.format(info.line_peak[0]);

				tab.querySelector('#mcs_tx_cur').firstChild.data = '%d'.format(info.line_current[1]);
				tab.querySelector('#mcs_tx_peak').firstChild.data = '%d'.format(info.line_peak[1]);
			});
		}

		ui.tabs.initTabGroup(v.firstElementChild.childNodes);

		this.pollData();

		return E([], [
			E('h2', _('Wireless')),
			E('div', {'class': 'cbi-map-descr'}, _('This page displays the wireless metrics, for each available radio interfaces.')),
			v
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
