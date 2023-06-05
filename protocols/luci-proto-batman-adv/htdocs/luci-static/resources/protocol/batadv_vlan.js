'use strict';
'require form';
'require network';


// WARNING: this is based on https://www.open-mesh.org/projects/batman-adv/wiki/Batman-adv-openwrt-config
// but hasn't actually been tested.

network.registerPatternVirtual(/^bat\d+/);

return network.registerProtocol('batadv_vlan', {
	getI18n: function() {
		return _('Batman VLAN interface');
	},

	getIfname: function() {
		return this._ubus('l3_device') || this.sid;
	},

	getOpkgPackage: function() {
		return 'kmod-batman-adv';
	},

	isFloating: function() {
		return true;
	},

	isVirtual: function() {
		return true;
	},

	getDevices: function() {
		return null;
	},

	containsDevice: function(ifname) {
		return (network.getIfnameOf(ifname) == this.getIfname());
	},

	renderFormOptions: function(s) {
		var dev = this.getL3Device() || this.getDevice(), 
			o;
			
		s.tab('mesh_vlan', _('Mesh VLAN Routing'), _('Mesh and routing related options'));

		o = s.taboption('mesh_vlan', form.Flag, 'ap_isolation', _('Access Point Isolation'), 
				_('Prevents one wireless client talking to another.'));
		o.ucioption = 'ap_isolation';
		o.default = o.disabled;
	}
});
