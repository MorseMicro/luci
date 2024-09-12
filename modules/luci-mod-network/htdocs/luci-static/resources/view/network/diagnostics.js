'use strict';
'require view';
'require dom';
'require fs';
'require ui';
'require uci';
'require network';

// Include custom CSS.
document.querySelector('head').appendChild(E('style', `
.commandline {
	display: flex;
	justify-content: space-between;
}

.commandline-input {
	flex-grow: 1;
	margin: 2px 0px 18px;
	font-family: monospace;
	font-size: 12px;
}

.commandline-chooser {
	display: flex;
	flex-wrap: wrap;

	select {
		max-width: 280px;
	}
}

.diag-action {
	margin: 2px 2px 2px 10px;
}

.data-tabs > div > div {
	padding: 0.4755rem 1.25rem;
}
`));


const IPERF3_MODE = {
	SERVER: 'SERVER',
	CLIENT: 'CLIENT',
};

async function performSinglePing(exec, args) {
	const res = await fs.exec(exec, args);
	let match;

	if (res.stdout && res.stdout.includes('100% packet loss')) {
		return null;
	} else if (res.stdout && (match = res.stdout.match(/bytes from.*time=(.*) ms/))) {
		return Number(match[1]);
	} else {
		return `${res.stdout || ''}${res.stderr || ''}`;
	}
}

async function* streamIperf3Data(cancelPromise, uniqueId, cmd, args) {
	// Pretend to stream iperf3 data, but really we're polling.
	// Strings that come back are stdout/stderr; arrays are parsed data for display
	// on a graph (we do this so we can more cleanly aggregate tx/rx and hide
	// the mess that is parsing the text from the upstream caller).

	const POLL_INTERVAL_MS = 500;  // We force the iperf3 interval to be 1 sec below.
	// e.g. [  5][TX-C]   3.00-4.00   sec  18.9 MBytes  158468 Kbits/sec    23    226 KBytes
	//            \1      (  \2   )                     ( \3 )              (   \4         )
	const iperfRegex = /\[[^\]]*\] *(?:\[(.X)-.\])? *(\d+\.\d+-\d+\.\d+) *sec .* (\S+) Kbits\/sec *(.*)?/;

	// Don't allow them to daemonise or use logfile, as it will mess with our backgrounding process.
	args = args.filter(arg => !arg.includes(['--daemon', '-D', '--logfile']))
	// Making the format consistent (i.e. one second intervals, kilobits) makes
	// it slightly easier to parse the iperf3 output.
	args.push(...['--forceflush', '-f', 'k', '-i', '1'])

	const server = args.includes('-s') || args.includes('--server');
	let lastDataTime = performance.now();

	while (true) {
		const lastPoll = performance.now();
		const result = await Promise.race([cancelPromise, fs.exec_direct('/usr/libexec/command-poll', [cmd, uniqueId, ...args])]);
		if (result === ui.CANCEL) {
			return;
		}
		let data = {tx: {}, rx: {}};

		for (const line of result.trim().split('\n')) {
			let match;
			if (['', 'iperf3: started'].includes(line.trim())) {
				continue;
			} else if (line.trim() === 'iperf3: ended') {
				return;
			} else if (match = line.match(iperfRegex)) {
				// dir tells us the direction in bidirectional mode, but we only
				// use it as a signifier of bidirectional mode, instead using
				// retries (=tx) as this works in all modes.
				const [dir, interval, kbits, remainder] = match.slice(1);
				const [start, end] = interval.split('-');
				const intervalSize = Number(end) - Number(start);

				// Ignore 'bad' intervals like 10.00-10.01, as we only expect ~ one second intervals,
				// and the end summary intervals (that start with 0.00).
				if (intervalSize > 0.2 && !(start === '0.00' && intervalSize > 1.5)) {
					// In TCP mode there are no retries in rx mode (i.e. empty remainder). In UDP mode
					// the receiver has a jitter in ms (I think...).
					data[!remainder || remainder.trim() === '(omitted)' || remainder.includes('ms') ? 'rx' : 'tx'] = {interval, kbits};

					// In bidirectional mode, we wait until the other interval is done.
					if (!dir || (data.rx.interval && data.tx.interval)) {
						yield [data.tx.kbits, data.rx.kbits];
						data = {tx: {}, rx: {}};
					}

					lastDataTime = performance.now();
				}
			}

			if (line !== '') {
				yield line;
			}
		}

		if (server && performance.now() > lastDataTime + 1200) {
			// Useful to report 'nothing happening' every now and again in `iperf3 -s` case.
			lastDataTime = performance.now();
			yield [null, null, null];
		}

		await new Promise(r => setTimeout(r, POLL_INTERVAL_MS - (performance.now() - lastPoll)));
	}
}

function calculatePingStats(packets, totalTransmitted) {
	const packetsReceived = packets.filter(p => p);
	const received = packetsReceived.length;
	const transmitted = Math.min(packets.length, totalTransmitted);

	const stats = {
		transmitted: transmitted,
		received: packetsReceived.length,
		lostProportion: (transmitted - packetsReceived.length) / transmitted,
	};

	if (received > 0) {
		packetsReceived.sort((a, b) => a - b);
		stats.median = packetsReceived[Math.floor(received / 2)];
		stats.average = packetsReceived.reduce(((s, v) => s + v), 0) / packetsReceived.length;
		stats.min = Math.min(...packetsReceived);
		stats.max = Math.max(...packetsReceived);
	}

	return stats;
}

function parseArgs(args) {
	// Just enough arg parsing for us to know something about our command line.
	const parsedArgs = {};

	let prevArg = null;
	for (const arg of args) {
		if (arg.startsWith('-')) {
			parsedArgs[arg] = true;
			prevArg = arg;
		} else if (prevArg) {
			parsedArgs[prevArg] = arg;
		}
	}

	return parsedArgs;
}

function renderPingStats(pingStats) {
	const lines = [];
	lines.push(`--- ping statistics (visible in graph; max 60 packets) ---`);
	lines.push(`${pingStats.transmitted} packets transmitted, ${pingStats.received} packets received, ${(pingStats.lostProportion * 100).toFixed(2)}% packet loss`);
	if (pingStats.received > 0) {
		lines.push(`round-trip min/median/avg/max = ${pingStats.min.toFixed(3)} ms, ${pingStats.median.toFixed(3)} ms, ${pingStats.average.toFixed(3)}, ${pingStats.max.toFixed(3)} ms`);
	}
	return lines.join('\n');
}

function makePingChart(dataset, chartDom) {
	const chartLabels = Array(dataset.data.length).fill(' ');

	// We want to keep dataset around and mutate it, as the caller wants to update it... hmm.
	Object.assign(dataset, {
		label: _('ping time (ms)'),
		borderWidth: 0,
		barPercentage: 1,
		categoryPercentage: 1,
	});

	return new Chart(chartDom, {
		type: 'bar',
		data: {
			labels: chartLabels,
			datasets: [dataset],
		},
		options: {
			scales: {
				y: {
					beginAtZero: true,
					min: 0,
					suggestedMax: 100,
					title: {display: true, text: _('ping time (ms)')},
				},
			},
			plugins: {
				legend: {
					display: false,
				},
				tooltip: {
					displayColors: false,
					callbacks: {
						title: () => _('ping time (ms)'),
						label: (context) => `${context.parsed.y} ms`,
					}
				},
			},
		},
	});
}

function makeIperf3Chart(txData, rxData, chartDom) {
	return new Chart(chartDom, {
		type: 'line',
		data: {
			labels: Array(txData.length).fill(' '),
			datasets: [{
				label: _('TX bitrate'),
				data: txData,
				borderColor: getComputedStyle(document.body).getPropertyValue('--primary-color-medium'),
			}, {
				label: _('RX bitrate'),
				data: rxData,
				borderColor: getComputedStyle(document.body).getPropertyValue('--success-color-medium'),
			}],
		},
		options: {
			scales: {
				y: {
					beginAtZero: true,
					min: 0,
					suggestedMax: 1000,
					title: {display: true, text: _('Bitrate (Kbits/sec)')},
				},
			},
		},
	});
}

return view.extend({
	/* Magical thing that creates a command line from our input form elements.
	 * Uses data attributes on the input elements to decide how to turn their
	 * value into something useful.
	 */
	updateCommandLine: function(tab) {
		const commandline_chooser = tab.querySelector('.commandline-chooser');
		const commandline_element = tab.querySelector('.commandline-input');

		const args = Array.from(commandline_chooser.querySelectorAll('input, select'))
			.filter(input => !(input.value.trim() === '' && input.dataset.arg.includes('::')))
			.map(input => input.dataset.arg.replace('::', input.value));

		const exec = (args.includes('-6') && commandline_chooser.dataset.execipv6) || commandline_chooser.dataset.exec;
		let commandline = exec;
		if (commandline_chooser.dataset.extraargs) {
			commandline += ' ' + commandline_chooser.dataset.extraargs;
		}
		if (args.length > 0) {
			commandline += ' ' + args.join(' ');
		}

		commandline_element.value = commandline;
	},

	getCommandLine: function(tab) {
		return tab.querySelector('.commandline-input').value.trim().split(/\s+/);
	},

	handleRun: async function(ev, cancelPromise) {
		const tab = ev.currentTarget.closest('[data-tab]');

		switch (tab.dataset.tab) {
			case "iperf3":
				await this.handleIperf3(IPERF3_MODE.CLIENT, tab, cancelPromise);
				break;
			case "iperf3-server":
				await this.handleIperf3(IPERF3_MODE.SERVER, tab, cancelPromise);
				break;
			case "ping":
				await this.handlePing(tab, cancelPromise);
				break;
			default:
				await this.handleCommand(tab, cancelPromise);
		}
	},

	handleCommand: async function(tab, cancelPromise) {
		var output = tab.querySelector('.text-output');
		output.style.display = 'none';

		var [exec, ...args] = this.getCommandLine(tab);

		try {
			const res = await Promise.race([cancelPromise, fs.exec(exec, args)]);
			if (res === ui.CANCEL) {
				return;
			}

			dom.content(output, [ res.stdout || '', res.stderr || '' ]);
			output.style.display = '';
		} catch (err) {
			ui.addNotification(null, E('p', [ err ]));
		}
	},

	handlePing: async function(tab, cancelPromise) {
		const MAX_PACKET_TIMINGS = 60;

		let [exec, ...args] = this.getCommandLine(tab);
		const out = tab.querySelector('.text-output');
		const chartDom = tab.querySelector('.diagnostics-chart');
		out.style.display = 'none';
		if (this.ping_chart) {
			this.ping_chart.destroy();
			this.ping_chart = undefined;
		}

		let totalTransmitted = 0;
		const packetTimings = Array(MAX_PACKET_TIMINGS).fill(null);
		const dataset = {
			data: packetTimings,
		};

		const parsedArgs = parseArgs(args);

		let interval_secs = 1;
		if (parsedArgs['-i']) {
			interval_secs = Number(parsedArgs['-i']);
			if (Number.isNaN(interval_secs) || interval_secs < 1 || interval_secs > 10) {
				console.log(interval_secs);
				out.style.display = '';
				dom.content(out, '-i must be between 1 and 10');
				return;
			}
		}

		let wait_secs = interval_secs;
		if (parsedArgs['-W']) {
			wait_secs = Number(parsedArgs['-W']);
			if (Number.isNaN(wait_secs) || wait_secs < 1 || wait_secs > 10) {
				console.log(wait_secs);
				out.style.display = '';
				dom.content(out, '-W must be between 1 and 10');
				return;
			}
		} else {
			args.push('-W', String(wait_secs));
		}

		let count = Number.MAX_SAFE_INTEGER;
		if (parsedArgs['-c']) {
			count = Number(parsedArgs['-c']);
			if (Number.isNaN(count) || count < 1) {
				out.style.display = '';
				dom.content(out, '-c must be greater than 1');
				return;
			}
		}
		args.push('-c', '1');

		try {
			for (i = 0; i < count; ++i) {
				const startInterval = performance.now();
				const result = await Promise.race([cancelPromise, performSinglePing(exec, args)]);
				if (result === ui.CANCEL) {
					break;
				}

				// Ping returned something we couldn't interpret. Show to user
				// and drop the graph.
				if (result !== null && typeof result !== 'number') {
					out.style.display = '';
					chartDom.parentNode.display = 'none';
					if (!result || result === '') {
						dom.content(out, 'Error calling ping.');
					} else {
						dom.content(out, result);
					}
					break;
				}

				const packetTime = result;
				packetTimings.push(packetTime);
				packetTimings.shift();

				const pingStats = calculatePingStats(packetTimings, ++totalTransmitted);

				// Render/update graph
				dataset.backgroundColor = packetTimings.map(ms => {
					if (ms < pingStats.median * 1.5) {
						return 'green';
					} else if (ms < pingStats.median * 3) {
						return 'orange';
					} else {
						return 'red';
					}
				})

				if (this.ping_chart === undefined) {
					chartDom.parentNode.style.display = '';
					this.ping_chart = makePingChart(dataset, chartDom);
				} else {
					this.ping_chart.update('none');
				}

				// Show stats (as text, echoing normal ping format).
				out.style.display = '';
				dom.content(out, renderPingStats(pingStats));

				const remainingTimeMs = startInterval + interval_secs * 1000 - performance.now();
				if (remainingTimeMs > 0) {
					await new Promise(r => setTimeout(r, remainingTimeMs));
				}
			}
		} catch (err) {
			ui.addNotification(null, E('p', [ err ]))
		}
	},

	handleIperf3: async function(mode, tab, cancelPromise) {
		const MAX_BITRATE_DATAPOINTS = 30;
		let [cmd, ...args] = this.getCommandLine(tab);

		const rxData = Array(MAX_BITRATE_DATAPOINTS).fill(null);
		const txData = Array(MAX_BITRATE_DATAPOINTS).fill(null);

		const out = tab.querySelector('.text-output');
		out.style.display = '';
		dom.content(out, '');
		Object.assign(out.style, {
			'display': 'none',
			'overflow-y': 'scroll',
			'height': '200px'
		});

		if (this.iperf3_charts[mode]) {
			this.iperf3_charts[mode].destroy();
			this.iperf3_charts[mode] = undefined;
		}

		const uniqueId = Math.random().toString(16).slice(2);

		try {
			for await (const result of streamIperf3Data(cancelPromise, uniqueId, cmd, args)) {
				if (Array.isArray(result)) {
					// We got some data.
					const [tx, rx] = result;
					txData.push(tx);
					txData.shift();
					rxData.push(rx);
					rxData.shift();

					if (this.iperf3_charts[mode] === undefined) {
						const chartDom = tab.querySelector('.diagnostics-chart');
						chartDom.parentNode.style.display = '';
						this.iperf3_charts[mode] = makeIperf3Chart(txData, rxData, chartDom);
					} else {
						this.iperf3_charts[mode].update('none');
					}
				} else {
					// It's probably something which we should display.
					// This handles both the final stats and error conditions.
					out.style.display = '';
					out.appendChild(E('span', {}, [result + '\n']));
					out.scrollTop = out.scrollHeight;
				}
			}
		} catch (err) {
			ui.addNotification(null, E('p', [ err ]))
		}
	},

	load: function() {
		return Promise.all([
			L.resolveDefault(fs.stat('/bin/ping6'), {}),
			L.resolveDefault(fs.stat('/usr/bin/ping6'), {}),
			L.resolveDefault(fs.stat('/bin/traceroute6'), {}),
			L.resolveDefault(fs.stat('/usr/bin/traceroute6'), {}),
			L.resolveDefault(fs.stat('/usr/bin/iperf3'), {}),
			L.resolveDefault(fs.stat('/usr/bin/arp-scan'), {}),
			network.getHostHints(),
			network.getDevices(),
			// Dodgy way to include some arbitrary lib that defines globals
			// (i.e. roughly equivalent to just putting it in the HTML, which
			// is not possible in a straight JS view in OpenWRT AFAIK).
			// Ideally we'd import an ES6 module here, but the current ChartJS ES6
			// module has a couple of dependency issues that would require manual hackery.
			import('./chart-4.min.js'),
			uci.load('luci')
		]);
	},

	render: function([has_ping6_bin, has_ping6_usr, has_traceroute6_bin, has_traceroute6_usr, has_iperf3, has_arpscan, host_hints, devices]) {
		var has_ping6 = has_ping6_bin || has_ping6_usr,
		    has_traceroute6 = has_traceroute6_bin || has_traceroute6_usr,
		    iperf3_host = uci.get('luci', 'diag', 'iperf3') || '',
		    dns_host = uci.get('luci', 'diag', 'dns') || '',
		    ping_host = uci.get('luci', 'diag', 'ping') || '',
		    route_host = uci.get('luci', 'diag', 'route') || '';

		const host_hints_datalist = [];
		for (const { ipaddrs, ip6addrs, name } of Object.values(host_hints.hosts)) {
			if (name) host_hints_datalist.push(name);
			host_hints_datalist.push(...ipaddrs);
			host_hints_datalist.push(...ip6addrs);
		}

		this.iperf3_charts = {};

		const make_command_output = (has_graph) => {
			return [
				E('div', { 'class': 'commandline' }, [
					E('input', { 'class': 'commandline-input' }),
					E('span', { 'class': 'diag-action' }, [
						E('button', {
							'class': 'cbi-button cbi-button-action',
							'click': ui.createCancellableHandlerFn(this, 'handleRun', 'Stop')
						}, [ _('Run') ])
					]),
				]),
				E('div', {}, [E('pre', { 'class': 'text-output', 'style': 'display:none' })]),
				has_graph ? E('div', { 'class': 'graph-output' }, E('canvas', { 'class': 'diagnostics-chart' })) : [],
			];
		}

		var tabs = E([], [
			E('div', { 'class': 'data-tabs' }, [
				E('div', { 'data-tab': 'ping', 'data-tab-title': 'Ping' }, [
					E('div', {
						'class': 'commandline-chooser',
						'data-exec': 'ping',
						'data-execipv6': has_ping6 ? 'ping6' : 'ping',
					}, [
						E('span', {}, [
							E('label', { 'for': 'ping-ipv6' }, _('Protocol')),
							E('select', {
								'id': 'ping-ipv6',
								'style': 'margin: 5px; width: auto;',
								'data-arg': '::',
							}, [
								E('option', { 'value': '-4' }, [ 'IPv4' ]),
								E('option', { 'value': '-6' }, [ 'IPv6' ]),
							]),
						]),
						E('input', {
							'required': '',
							'style': 'margin: 5px; width: auto;',
							'type': 'text',
							'list': 'ping-host-hints',
							'data-arg': '::',
							'value': ping_host,
						}),
					]),
					...make_command_output(true),
				]),

				has_iperf3 ? E('div', { 'data-tab': 'iperf3', 'data-tab-title': 'IPerf3 Client' }, [
					E('div', {
						'class': 'commandline-chooser',
						'data-exec': 'iperf3',
						'data-extraargs': '-c',
					}, [
						E('span', {}, [
							E('label', { 'for': 'iperf3-host' }, _('Host')),
							E('input', {
								'id': 'iperf3-host',
								'required': '',
								'style': 'margin: 5px; width: 140px;',
								'type': 'text',
								'list': 'iperf3-host-hints',
								'data-arg': '::',
								'value': iperf3_host,
							}),
						]),
						E('span', {}, [
							E('label', { 'for': 'iperf3-ipv6' }, _('Protocol')),
							E('select', {
								'id': 'iperf3-ipv6',
								'style': 'margin: 5px; width: auto;',
								'data-arg': '::',
								'value': '-4',
							}, [
								E('option', { 'value': '-4' }, [ 'IPv4' ]),
								E('option', { 'value': '-6' }, [ 'IPv6' ]),
							]),
						]),
						E('span', {}, [
							E('select', {
								'style': 'margin: 5px; width: auto;',
								'data-arg': '::',
								'value': '',
							}, [
								E('option', { 'value': '' }, [ _('TCP') ]),
								E('option', { 'value': '-u' }, [ _('UDP') ]),
							]),
						]),
						E('span', {}, [
							E('select', {
								'style': 'margin: 5px; width: auto;',
								'data-arg': '::',
								'value': '',
							}, [
								E('option', { 'value': '' }, [ _('TX') ]),
								E('option', { 'value': '--reverse' }, [ _('RX') ]),
								E('option', { 'value': '--bidir' }, [ _('Bidir') ]),
							]),
						]),
						E('span', {}, [
							E('label', { 'for': 'iperf3-bitrate' }, _('Bitrate (#[KMG][/#])')),
							E('input', {
								'id': 'iperf3-bitrate',
								'style': 'margin: 5px',
								'size': 4,
								'type': 'text',
								'data-arg': '--bitrate ::',
								'value': '30M',
							}),
						]),
						E('span', {}, [
							E('label', { 'for': 'iperf3-time' }, _('Seconds')),
							E('input', {
								'id': 'iperf3-time',
								'style': 'margin: 5px',
								'size': 4,
								'type': 'number',
								'data-arg': '--time ::',
								'value': '30',
								'min': 2,
							}),
						]),
						E('span', {}, [
							E('label', { 'for': 'iperf3-omit' }, _('Omit (secs)')),
							E('input', {
								'id': 'iperf3-omit',
								'style': 'margin: 5px',
								'size': 3,
								'type': 'number',
								'data-arg': '--omit ::',
								'value': '10',
								'min': 0,
							}),
						]),
					]),
					...make_command_output(true),
				]) : [],

				has_iperf3 ? E('div', { 'data-tab': 'iperf3-server', 'data-tab-title': 'IPerf3 Server' }, [
					E('div', {
						'class': 'commandline-chooser',
						'data-exec': 'iperf3',
						'data-extraargs': '-s',
					}),
					...make_command_output(true),
				]) : [],

				E('div', { 'data-tab': 'traceroute', 'data-tab-title': 'Traceroute' }, [
					E('div', {
						'class': 'commandline-chooser',
						'data-exec': 'traceroute',
						'data-execipv6': has_traceroute6 ? 'traceroute6' : 'traceroute',
						'data-extraargs': `-q 1 -w 1 -n -m ${L.env.rpctimeout || 20}`,
					}, [
						E('span', {}, [
							E('label', { 'for': 'traceroute-ipv6' }, _('Protocol')),
							E('select', {
								'id': 'traceroute-ipv6',
								'style': 'margin: 5px; width: auto;',
								'data-arg': '::',
							}, [
								E('option', { 'value': '-4' }, [ 'IPv4' ]),
								E('option', { 'value': '-6' }, [ 'IPv6' ]),
							]),
						]),
						E('span', {}, [
							E('label', { 'for': 'traceroute-host' }, _('Host')),
							E('input', {
								'id': 'traceroute-host',
								'required': '',
								'style': 'margin: 5px; width: auto;',
								'type': 'text',
								'list': 'route-host-hints',
								'data-arg': '::',
								'value': route_host,
							}),
						]),
					]),
					...make_command_output(),
				]),

				E('div', { 'data-tab': 'nslookup', 'data-tab-title': 'nslookup' }, [
					E('div', {
						'class': 'commandline-chooser',
						'data-exec': 'nslookup',
					}, [
						E('span', {}, [
							E('label', { 'for': 'nslookup-host' }, _('Host')),
							E('input', {
								'id': 'nslookup-host',
								'required': '',
								'style': 'margin: 5px; width: auto;',
								'type': 'text',
								'list': 'dns-host-hints',
								'data-arg': '::',
								'value': dns_host,
							}),
						]),
						E('span', {}, [
							E('label', { 'for': 'nslookup-dnsserver' }, _('DNS server')),
							E('input', {
								'id': 'nslookup-dnsserver',
								'style': 'margin: 5px; width: auto;',
								'type': 'text',
								'list': 'dns-host-hints',
								'data-arg': '::',
							}),
						]),
					]),
					...make_command_output(),
				]),

				has_arpscan ?  E('div', { 'data-tab': 'arp-scan', 'data-tab-title': 'ARP scan' }, [
					E('div', {
						'class': 'commandline-chooser',
						'data-exec': 'arp-scan',
						'data-extraargs': '-t 1000 -l -I',
					}, [
						E('span', {}, [
							E('label', { 'for': 'arp-interface' }, _('Interface')),
							E('select', {
								'id': 'arp-interface',
								'style': 'margin: 5px; width: auto;',
								'data-arg': '::',
							}, devices.map(function(device) {
								if (!device.isUp())
									return E([]);

								return E('option', { 'value': device.getName() }, [ device.getI18n() ]);
							})),
						]),
					]),
					...make_command_output(),
				]) : [],
			])
		])

		ui.tabs.initTabGroup(tabs.lastChild.childNodes);

		var view = E('div', { 'class': 'cbi-map'}, [
			E('h2', {}, [ _('Diagnostics') ]),
			E('div', { 'class': 'cbi-map-descr'}, _('Execution of various network commands to check the connection and name resolution to other systems.')),
			E('datalist', { 'id': 'iperf3-host-hints' }, [iperf3_host].concat(host_hints_datalist).map(hh => E('option', { 'value': hh }))),
			E('datalist', { 'id': 'dns-host-hints' }, [dns_host].concat(host_hints_datalist).map(hh => E('option', { 'value': hh }))),
			E('datalist', { 'id': 'ping-host-hints' }, [ping_host].concat(host_hints_datalist).map(hh => E('option', { 'value': hh }))),
			E('datalist', { 'id': 'route-host-hints' }, [route_host].concat(host_hints_datalist).map(hh => E('option', { 'value': hh }))),
			tabs,
		]);

		for (const input_elem of view.querySelectorAll('.commandline-chooser input, .commandline-chooser select')) {
			input_elem.addEventListener('input', ev => {
				ev.currentTarget.reportValidity();
				this.updateCommandLine(ev.currentTarget.closest('[data-tab]'))
			});
		}

		for (const tab of view.querySelectorAll('div[data-tab]')) {
			this.updateCommandLine(tab);
		}

		return view;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
