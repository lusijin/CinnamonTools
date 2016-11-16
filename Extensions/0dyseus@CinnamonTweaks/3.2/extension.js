const Lang = imports.lang;
const Settings = imports.ui.settings;
const Main = imports.ui.main;
const AppletManager = imports.ui.appletManager;
const DeskletManager = imports.ui.deskletManager;
const Mainloop = imports.mainloop;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gettext = imports.gettext;
const Extension = imports.ui.extension;
const Cinnamon = imports.gi.Cinnamon;
const CINNAMON_VERSION = GLib.getenv("CINNAMON_VERSION");
const Applet = imports.ui.applet;
const Desklet = imports.ui.desklet;
const PopupMenu = imports.ui.popupMenu;
const Signals = imports.signals;
const Util = imports.misc.util;
const Gio = imports.gi.Gio;
const DESKTOP_SCHEMA = 'org.cinnamon.desktop.interface';
const CURSOR_SIZE_KEY = 'cursor-size';
const Tooltips = imports.ui.tooltips;
const St = imports.gi.St;

let $,
    settings,
    metadata,
    allowEnabling = false;

function _(aStr) {
    let customTrans = Gettext.dgettext(metadata.uuid, aStr);
    if (customTrans != aStr) {
        return customTrans;
    }
    return Gettext.gettext(aStr);
}

let IDS = {
    TTP: 0, // CT_TooltipsPatch toggle ID.
    MTP: 0, // CT_MessageTrayPatch toggle ID.
    DMP: 0, // CT_DeskletManagerPatch toggle ID.
    AMP: 0, // CT_AppletManagerPatch toogle ID.
    WDAE: 0, // CT_WindowDemandsAttentionBehavior toogle ID.
    EXEC_WDAE: 0, // CT_WindowDemandsAttentionBehavior execution ID.
    CONNECTION_WDAE: 0, // CT_WindowDemandsAttentionBehavior connection ID.
};

/**
 * Container for old attributes and functions for later restore.
 */
let STG = {
    TTP: {},
    HCP: {},
    MTP: {},
    AMP: {},
    DMP: {}
};

function dealWithRejection(aTweakDescription) {
    Main.warningNotify(_(metadata.name), _(aTweakDescription) + "\n" +
        _("Tweak ativation aborted!!!") + "\n" +
        _("Your Cinnamon version may not be compatible!!!"));
}

function togglePatch(aPatch, aID, aEnabledPref) {
    try {
        aPatch.disable();
        if (IDS[aID] > 0) {
            Mainloop.source_remove(IDS[aID]);
            IDS[aID] = 0;
        }

        if (!aEnabledPref)
            return true;

        IDS[aID] = Mainloop.timeout_add(1000, Lang.bind(aPatch, function() {
            aPatch.enable();
            IDS[aID] = 0;
            return false;
        }));
    } catch (aErr) {
        global.logError(aErr);
    }
}

function informAndDisable() {
    try {
        let msg = _("Extension ativation aborted!!!") + "\n" +
            _("Your Cinnamon version may not be compatible!!!") + "\n" +
            _("Minimum Cinnamon version allowed: 2.8.6");
        global.logError(msg);
        Main.criticalNotify(_(metadata.name), msg);
    } finally {
        let enabledExtensions = global.settings.get_strv("enabled-extensions");
        Extension.unloadExtension(metadata.uuid, Extension.Type.EXTENSION);
        enabledExtensions.splice(enabledExtensions.indexOf(metadata.uuid), 1);
        global.settings.set_strv("enabled-extensions", enabledExtensions);
    }
}

function injectToFunction(aParent, aName, aFunc) {
    let origin = aParent[aName];
    aParent[aName] = function() {
        let ret;
        ret = origin.apply(this, arguments);
        if (ret === undefined)
            ret = aFunc.apply(this, arguments);
        return ret;
    };
    return origin;
}

function removeInjection(aStorage, aInjection, aName) {
    if (aInjection[aName] === undefined)
        delete aStorage[aName];
    else
        aStorage[aName] = aInjection[aName];
}

const CT_AppletManagerPatch = {
    enable: function() {
        if (settings.pref_applets_add_open_folder_item_to_context ||
            settings.pref_applets_add_edit_file_item_to_context) {
            STG.AMP.finalizeContextMenu = injectToFunction(Applet.Applet.prototype, "finalizeContextMenu", function() {
                let menuItems = this._applet_context_menu._getMenuItems();
                let itemsLength = menuItems.length;
                if (itemsLength > 0) {
                    let getPosition = Lang.bind(this, function(aPos) {
                        let pos;
                        switch (Number(aPos)) {
                            case 0: // Last place
                                pos = itemsLength;
                                break;
                            case 1: // Before "Remove..."
                                pos = menuItems.indexOf(this.context_menu_item_remove);
                                break;
                            case 2: // Before "Configure..."
                                if (menuItems.indexOf(this.context_menu_item_configure) !== -1)
                                    pos = menuItems.indexOf(this.context_menu_item_configure);
                                else
                                    pos = menuItems.indexOf(this.context_menu_item_remove);
                                break;
                            case 3: // Before "About..."
                                pos = menuItems.indexOf(this.context_menu_item_about);
                                break;
                        }
                        while (pos < 0) {
                            ++pos;
                        }
                        return pos;
                    });

                    if (settings.pref_applets_add_open_folder_item_to_context) {
                        let position = getPosition(settings.pref_applets_add_open_folder_item_to_context_placement);
                        let item = new PopupMenu.PopupIconMenuItem(
                            _("Open applet folder"),
                            "folder",
                            St.IconType.SYMBOLIC);
                        item.connect("activate", Lang.bind(this, function() {
                            Util.spawnCommandLine("xdg-open " + this._meta["path"]);
                        }));
                        this._applet_context_menu.addMenuItem(item, position);
                    }

                    if (settings.pref_applets_add_edit_file_item_to_context) {
                        let position = getPosition(settings.pref_applets_add_edit_file_item_to_context_placement);
                        let item = new PopupMenu.PopupIconMenuItem(
                            _("Edit applet main file"),
                            "text-editor",
                            St.IconType.SYMBOLIC);
                        item.connect("activate", Lang.bind(this, function() {
                            Util.spawnCommandLine("xdg-open " + this._meta["path"] + "/applet.js");
                        }));
                        this._applet_context_menu.addMenuItem(item, position);
                    }
                }
            });
        }

        if (settings.pref_applets_ask_confirmation_applet_removal) {
            let am = AppletManager;
            // Extracted from /usr/share/cinnamon/js/ui/appletManager.js
            // Patch Appletmanager._removeAppletFromPanel to ask for confirmation on applet removal.
            STG.AMP._removeAppletFromPanel = am._removeAppletFromPanel;
            am._removeAppletFromPanel = function(uuid, applet_id) {
                let removeApplet = function() {
                    try {
                        let enabledApplets = am.enabledAppletDefinitions.raw;
                        for (let i = 0; i < enabledApplets.length; i++) {
                            let appletDefinition = am.getAppletDefinition(enabledApplets[i]);
                            if (appletDefinition) {
                                if (uuid == appletDefinition.uuid && applet_id == appletDefinition.applet_id) {
                                    let newEnabledApplets = enabledApplets.slice(0);
                                    newEnabledApplets.splice(i, 1);
                                    global.settings.set_strv('enabled-applets', newEnabledApplets);
                                    break;
                                }
                            }
                        }
                    } catch (aErr) {
                        global.logError(aErr.message);
                    }
                };
                let ctrlKey = Clutter.ModifierType.CONTROL_MASK & global.get_pointer()[2];

                if (ctrlKey)
                    removeApplet();
                else
                    new $.ConfirmationDialog(function() {
                            removeApplet();
                        },
                        "Applet removal",
                        _("Do you want to remove '%s' from your panel?\nInstance ID: %s")
                        .format(AppletManager.get_object_for_uuid(uuid, applet_id)._meta.name, applet_id),
                        _("OK"),
                        _("Cancel")).open();
            };
        }
    },

    disable: function() {
        if (STG.AMP.finalizeContextMenu) {
            removeInjection(Applet.Applet.prototype, STG.AMP, "finalizeContextMenu");
        }
        if (STG.AMP._removeAppletFromPanel) {
            AppletManager._removeAppletFromPanel = STG.AMP._removeAppletFromPanel;
            delete STG.AMP._removeAppletFromPanel;
        }
    },

    toggle: function() {
        togglePatch(CT_AppletManagerPatch, "AMP", settings.pref_applets_tweaks_enabled);
    }
};

const CT_DeskletManagerPatch = {
    enable: function() {
        if (settings.pref_desklets_add_open_folder_item_to_context ||
            settings.pref_desklets_add_edit_file_item_to_context) {
            STG.DMP.finalizeContextMenu = injectToFunction(Desklet.Desklet.prototype, "finalizeContextMenu", function() {
                let menuItems = this._menu._getMenuItems();
                let itemsLength = menuItems.length;
                if (itemsLength > 0) {
                    let getPosition = Lang.bind(this, function(aPos) {
                        let pos;
                        switch (Number(aPos)) {
                            case 0: // Last place
                                pos = itemsLength;
                                break;
                            case 1: // Before "Remove..."
                                pos = menuItems.indexOf(this.context_menu_item_remove);
                                break;
                            case 2: // Before "Configure..."
                                if (menuItems.indexOf(this.context_menu_item_configure) !== -1)
                                    pos = menuItems.indexOf(this.context_menu_item_configure);
                                else
                                    pos = menuItems.indexOf(this.context_menu_item_remove);
                                break;
                            case 3: // Before "About..."
                                pos = menuItems.indexOf(this.context_menu_item_about);
                                break;
                        }
                        while (pos < 0) {
                            ++pos;
                        }
                        return pos;
                    });

                    if (settings.pref_desklets_add_open_folder_item_to_context) {
                        let position = getPosition(settings.pref_desklets_add_open_folder_item_to_context_placement);
                        let item = new PopupMenu.PopupIconMenuItem(
                            _("Open desklet folder"),
                            "folder",
                            St.IconType.SYMBOLIC);
                        item.connect("activate", Lang.bind(this, function() {
                            Util.spawnCommandLine("xdg-open " + this._meta["path"]);
                        }));
                        this._menu.addMenuItem(item, position);
                    }

                    if (settings.pref_desklets_add_edit_file_item_to_context) {
                        let position = getPosition(settings.pref_desklets_add_edit_file_item_to_context_placement);
                        let item = new PopupMenu.PopupIconMenuItem(
                            _("Edit desklet main file"),
                            "text-editor",
                            St.IconType.SYMBOLIC);
                        item.connect("activate", Lang.bind(this, function() {
                            Util.spawnCommandLine("xdg-open " + this._meta["path"] + "/desklet.js");
                        }));
                        this._menu.addMenuItem(item, position);
                    }
                }
            });
        }

        if (settings.pref_desklets_ask_confirmation_desklet_removal) {
            let dm = DeskletManager;

            // Extracted from /usr/share/cinnamon/js/ui/deskletManager.js
            // Patch DeskletManager.removeDesklet to ask for confirmation on desklet removal.
            STG.DMP.removeDesklet = dm.removeDesklet;
            dm.removeDesklet = function(uuid, desklet_id) {
                let ENABLED_DESKLETS_KEY = "enabled-desklets";
                let removeDesklet = function() {
                    try {
                        let list = global.settings.get_strv(ENABLED_DESKLETS_KEY);
                        for (let i = 0; i < list.length; i++) {
                            let definition = list[i];
                            let elements = definition.split(":");
                            if (uuid == elements[0] && desklet_id == elements[1]) list.splice(i, 1);
                        }
                        global.settings.set_strv(ENABLED_DESKLETS_KEY, list);
                    } catch (aErr) {
                        global.logError(aErr.message);
                    }
                };
                let ctrlKey = Clutter.ModifierType.CONTROL_MASK & global.get_pointer()[2];

                if (ctrlKey)
                    removeDesklet();
                else
                    new $.ConfirmationDialog(function() {
                            removeDesklet();
                        },
                        "Desklet removal",
                        _("Do you want to remove '%s' from your desktop?\nInstance ID: %s")
                        .format(DeskletManager.get_object_for_uuid(uuid, desklet_id)._meta.name, desklet_id),
                        _("OK"),
                        _("Cancel")).open();
            };
        }
    },

    disable: function() {
        if (STG.DMP.finalizeContextMenu) {
            removeInjection(Desklet.Desklet.prototype, STG.DMP, "finalizeContextMenu");
        }
        if (STG.DMP.removeDesklet) {
            DeskletManager.removeDesklet = STG.DMP.removeDesklet;
            delete STG.DMP.removeDesklet;
        }
    },

    toggle: function() {
        togglePatch(CT_DeskletManagerPatch, "DMP", settings.pref_desklets_tweaks_enabled);
    }
};

const CT_MessageTrayPatch = {
    enable: function() {
        let mt = Main.messageTray;
        let position = settings.pref_notifications_position; // true = bottom, false = top
        let distanceFromPanel = Number(settings.pref_notifications_distance_from_panel);
        let ANIMATION_TIME = settings.pref_notifications_enable_animation ? 0.2 : 0.001;
        let State = {
            HIDDEN: 0,
            SHOWING: 1,
            SHOWN: 2,
            HIDING: 3
        };

        // Extracted from /usr/share/cinnamon/js/ui/messageTray.js
        // Patch _hideNotification to allow correct animation.
        STG.MTP._hideNotification = mt._hideNotification;
        mt._hideNotification = function() {
            this._focusGrabber.ungrabFocus();
            if (this._notificationExpandedId) {
                this._notification.disconnect(this._notificationExpandedId);
                this._notificationExpandedId = 0;
            }

            this._tween(this._notificationBin, '_notificationState', State.HIDDEN, {
                y: (position ?
                    Main.layoutManager.primaryMonitor.height :
                    Main.layoutManager.primaryMonitor.y),
                opacity: 0,
                time: ANIMATION_TIME,
                transition: 'easeOutQuad',
                onComplete: this._hideNotificationCompleted,
                onCompleteScope: this
            });
        };

        // Patch _showNotification to allow correct animation and custom right margin.
        STG.MTP._showNotification = mt._showNotification;
        mt._showNotification = function() {
            this._notificationTimeoutId = 1;
            this._notification = this._notificationQueue.shift();
            if (this._notification.actor._parent_container) {
                this._notification.collapseCompleted();
                this._notification.actor._parent_container.remove_actor(this._notification.actor);
            }
            this._notificationClickedId = this._notification.connect('done-displaying',
                Lang.bind(this, this._escapeTray));
            this._notificationBin.child = this._notification.actor;
            this._notificationBin.opacity = 0;

            let monitor = Main.layoutManager.primaryMonitor;
            let panel = Main.panelManager.getPanel(0, position); // If Cinnamon 3.0.7 stable and older
            if (!panel)
                panel = Main.panelManager.getPanel(0, Number(position ? 1 : 0)); // If Cinnamon 3.0.7 nightly and newer(?)
            let height = 5;
            if (panel)
                height += panel.actor.get_height();
            this._notificationBin.y = position ?
                monitor.height - height / 2 :
                monitor.y + height * 2;

            let margin = this._notification._table.get_theme_node().get_length('margin-from-right-edge-of-screen');
            if (settings.pref_notifications_right_margin !== 0)
                margin = settings.pref_notifications_right_margin;
            this._notificationBin.x = monitor.x + monitor.width - this._notification._table.width - margin;
            Main.soundManager.play('notification');
            this._notificationBin.show();

            this._updateShowingNotification();

            let [x, y, mods] = global.get_pointer();
            this._showNotificationMouseX = x;
            this._showNotificationMouseY = y;
            this._lastSeenMouseY = y;
        };

        // Patch _onNotificationExpanded to allow correct showing animation and custom top/bottom margins.
        STG.MTP._onNotificationExpanded = mt._onNotificationExpanded;
        mt._onNotificationExpanded = function() {
            let expandedY = this._notification.actor.height - this._notificationBin.height;

            let monitor = Main.layoutManager.primaryMonitor;
            let panel = Main.panelManager.getPanel(0, position); // If Cinnamon 3.0.7 stable and older
            if (!panel)
                panel = Main.panelManager.getPanel(0, Number(position ? 1 : 0)); // If Cinnamon 3.0.7 nightly and newer(?)
            let height = 0;
            if (panel)
                height += panel.actor.get_height();
            let newY = position ?
                monitor.height - this._notificationBin.height - height - distanceFromPanel :
                monitor.y + height + distanceFromPanel;

            if (this._notificationBin.y < expandedY)
                this._notificationBin.y = expandedY;
            else if (this._notification.y != expandedY)
                this._tween(this._notificationBin, '_notificationState', State.SHOWN, {
                    y: newY,
                    time: ANIMATION_TIME,
                    transition: 'easeOutQuad'
                });
        };
    },

    disable: function() {
        if (STG.MTP._hideNotification) {
            Main.messageTray._hideNotification = STG.MTP._hideNotification;
            delete STG.MTP._hideNotification;
        }
        if (STG.MTP._showNotification) {
            Main.messageTray._showNotification = STG.MTP._showNotification;
            delete STG.MTP._showNotification;
        }
        if (STG.MTP._onNotificationExpanded) {
            Main.messageTray._onNotificationExpanded = STG.MTP._onNotificationExpanded;
            delete STG.MTP._onNotificationExpanded;
        }
    },

    toggle: function() {
        togglePatch(CT_MessageTrayPatch, "MTP", settings.pref_notifications_enable_tweaks);
    }
};

const SHORTCUT_ID = "cinnamon-tweaks-window-demands-attention-shortcut";

const WindowDemandsAttentionClass = new Lang.Class({
    Name: "Window Demands Attention",

    _init: function() {
        if (settings.pref_win_demands_attention_activation_mode === "hotkey") {
            this._windows = [];
            IDS.CONNECTION_WDAE = global.display.connect(
                "window-demands-attention",
                Lang.bind(this, this._on_window_demands_attention)
            );
        } else if (settings.pref_win_demands_attention_activation_mode === "force") {
            this._tracker = Cinnamon.WindowTracker.get_default();
            this._handlerid = global.display.connect("window-demands-attention",
                Lang.bind(this, this._on_window_demands_attention));
        }
    },

    _on_window_demands_attention: function(aDisplay, aWin) {
        switch (settings.pref_win_demands_attention_activation_mode) {
            case "hotkey":
                this._windows.push(aWin);
                break;
            case "force":
                Main.activateWindow(aWin);
                break;
        }
    },

    _activate_last_window: function() {
        if (this._windows.length === 0) {
            Main.notify("No windows in the queue.");
            return;
        }

        let last_window = this._windows.pop();
        Main.activateWindow(last_window);
    },

    _add_keybindings: function() {
        Main.keybindingManager.addHotKey(
            SHORTCUT_ID,
            settings.pref_win_demands_attention_keyboard_shortcut,
            Lang.bind(this, this._activate_last_window));
    },

    _remove_keybindings: function() {
        Main.keybindingManager.removeHotKey(SHORTCUT_ID);
    },

    enable: function() {
        if (settings.pref_win_demands_attention_activation_mode === "hotkey")
            this._add_keybindings();
    },

    _destroy: function() {
        try {
            global.display.disconnect(this._handlerid);
        } catch (aErr) {}

        try {
            global.display.disconnect(IDS.CONNECTION_WDAE);
        } catch (aErr) {}

        IDS.CONNECTION_WDAE = 0;
        this._windows = null;
        this._remove_keybindings();
    }
});

const CT_WindowDemandsAttentionBehavior = {
    enable: function() {
        try {
            if (IDS.EXEC_WDAE > 0)
                this.disable();
        } finally {
            IDS.EXEC_WDAE = new WindowDemandsAttentionClass();
            IDS.EXEC_WDAE.enable();
        }
    },

    disable: function() {
        if (IDS.EXEC_WDAE > 0) {
            IDS.EXEC_WDAE._destroy();
            IDS.EXEC_WDAE = 0;
        }
    },

    toggle: function() {
        togglePatch(CT_WindowDemandsAttentionBehavior,
            "WDAE",
            settings.pref_win_demands_attention_activation_mode !== "none");
    }
};

const CT_TooltipsPatch = {
    enable: function() {
        if (this.shouldEnable("delay")) {
            if (settings.pref_tooltips_delay !== 300) {
                STG.TTP._onMotionEvent = Tooltips.TooltipBase._onMotionEvent;
                Tooltips.TooltipBase.prototype["_onMotionEvent"] = function(actor, event) {
                    if (this._showTimer) {
                        Mainloop.source_remove(this._showTimer);
                        this._showTimer = null;
                    }

                    if (!this.visible) {
                        this._showTimer = Mainloop.timeout_add(settings.pref_tooltips_delay,
                            Lang.bind(this, this._onTimerComplete));
                        this.mousePosition = event.get_coords();
                    }
                };

                STG.TTP._onEnterEvent = Tooltips.TooltipBase._onEnterEvent;
                Tooltips.TooltipBase.prototype["_onEnterEvent"] = function(actor, event) {
                    if (!this._showTimer) {
                        this._showTimer = Mainloop.timeout_add(settings.pref_tooltips_delay,
                            Lang.bind(this, this._onTimerComplete));
                        this.mousePosition = event.get_coords();
                    }
                };
            }
        }
    },

    disable: function() {
        if (STG.TTP._onMotionEvent) {
            Tooltips.TooltipBase.prototype["_onMotionEvent"] = STG.TTP._onMotionEvent;
            delete STG.TTP._onMotionEvent;
        }
        if (STG.TTP._onEnterEvent) {
            Tooltips.Tooltip.prototype["_onEnterEvent"] = STG.TTP._onEnterEvent;
            delete STG.TTP._onEnterEvent;
        }
        if (STG.TTP.show) {
            Tooltips.Tooltip.prototype["show"] = STG.TTP.show;
            delete STG.TTP.show;
        }
    },

    toggle: function() {
        togglePatch(CT_TooltipsPatch, "TTP", settings.pref_tooltips_tweaks_enabled);
    },

    shouldEnable: function(aTweak) {
        switch (aTweak) {
            case "delay":
                return true;
            case "positioning":
                return $.versionCompare(CINNAMON_VERSION, "3.0.7") <= 0;
        }
    }
};

/**
 * [Template]
 */
// const CT_Patch = {
// 	enable: function() {
// 		//
// 	},
//
// 	disable: function() {
// 		//
// 	},
//
// 	toggle: function() {
// 		togglePatch(CT_Patch, "Key from IDS object", settings.pref_that_enables_this_patch);
// 	}
// };

function SettingsHandler(aUUID) {
    this._init(aUUID);
}

SettingsHandler.prototype = {
    __proto__: Settings.ExtensionSettings.prototype,

    _init: function(aUUID) {
        this.settings = new Settings.ExtensionSettings(this, aUUID);
        let settingsArray = [
            ["pref_applets_tweaks_enabled", CT_AppletManagerPatch.toggle],
            ["pref_applets_ask_confirmation_applet_removal", CT_AppletManagerPatch.toggle],
            ["pref_applets_add_open_folder_item_to_context", CT_AppletManagerPatch.toggle],
            ["pref_applets_add_edit_file_item_to_context", CT_AppletManagerPatch.toggle],
            ["pref_applets_add_open_folder_item_to_context_placement", CT_AppletManagerPatch.toggle],
            ["pref_applets_add_edit_file_item_to_context_placement", CT_AppletManagerPatch.toggle],
            ["pref_desklets_tweaks_enabled", CT_DeskletManagerPatch.toggle],
            ["pref_desklets_ask_confirmation_desklet_removal", CT_DeskletManagerPatch.toggle],
            ["pref_desklets_add_open_folder_item_to_context", CT_DeskletManagerPatch.toggle],
            ["pref_desklets_add_edit_file_item_to_context", CT_DeskletManagerPatch.toggle],
            ["pref_desklets_add_open_folder_item_to_context_placement", CT_DeskletManagerPatch.toggle],
            ["pref_desklets_add_edit_file_item_to_context_placement", CT_DeskletManagerPatch.toggle],
            ["pref_notifications_enable_tweaks", CT_MessageTrayPatch.toggle],
            ["pref_notifications_enable_animation", CT_MessageTrayPatch.toggle],
            ["pref_notifications_position", CT_MessageTrayPatch.toggle],
            ["pref_notifications_distance_from_panel", CT_MessageTrayPatch.toggle],
            ["pref_notifications_right_margin", CT_MessageTrayPatch.toggle],
            ["pref_win_demands_attention_activation_mode", CT_WindowDemandsAttentionBehavior.toggle],
            ["pref_win_demands_attention_keyboard_shortcut", CT_WindowDemandsAttentionBehavior.toggle],
            ["pref_tooltips_tweaks_enabled", CT_TooltipsPatch.toggle],
            ["pref_tooltips_delay", CT_TooltipsPatch.toggle],
            ["pref_initial_load", null],
        ];
        for (let [property_name, callback] of settingsArray) {
            this.settings.bind(property_name, property_name, callback);
        }
    }
};

/**
 * Called when extension is loaded
 */
function init(aExtensionMeta) {
    metadata = aExtensionMeta;
    settings = new SettingsHandler(metadata.uuid);
    Gettext.bindtextdomain(metadata.uuid, GLib.get_home_dir() + "/.local/share/locale");
    let extension_dir = metadata.path;
    let main_extension_dir = extension_dir;

    try {
        // Use the main_extension_dir directory for imports shared by all
        // supported Cinnamon versions.
        // If I use just extension_dir, I would be forced to put the
        // files to be imported repeatedly inside each version folder. ¬¬
        let regExp = new RegExp("(" + metadata.uuid + ")$", "g");
        if (!regExp.test(main_extension_dir)) {
            let tempFile = Gio.file_new_for_path(main_extension_dir);
            main_extension_dir = tempFile.get_parent().get_path();
        }
    } finally {
        imports.searchPath.push(main_extension_dir);

        $ = imports.extensionModules;

        try {
            allowEnabling = $.versionCompare(CINNAMON_VERSION, "2.8.6") >= 0;
        } catch (aErr) {
            global.logError(aErr.message);
            allowEnabling = false;
        }
    }
}

/**
 * Called when extension is loaded
 */
function enable() {
    // DO NOT allow to enable extension if it isn't installed on a proper Cinnamon version.
    if (allowEnabling) {
        try {
            if (settings.pref_applets_tweaks_enabled)
                CT_AppletManagerPatch.enable();
        } catch (aErr) {
            global.logError(aErr.message);
        }

        try {
            if (settings.pref_desklets_tweaks_enabled)
                CT_DeskletManagerPatch.enable();
        } catch (aErr) {
            global.logError(aErr.message);
        }

        try {
            if (settings.pref_notifications_enable_tweaks)
                CT_MessageTrayPatch.enable();
        } catch (aErr) {
            global.logError(aErr.message);
        }

        try {
            if (settings.pref_win_demands_attention_activation_mode !== "none")
                CT_WindowDemandsAttentionBehavior.enable();
        } catch (aErr) {
            global.logError(aErr.message);
        }

        try {
            if (settings.pref_tooltips_tweaks_enabled)
                CT_TooltipsPatch.enable();
        } catch (aErr) {
            global.logError(aErr.message);
        }

        let msg = [
            _("If you updated this extension from an older version, <b>you must check its settings window</b>."),
            _("Some preferences may have been changed to their default values."),
            _("This message will not be displayed again.")
        ];

        if (!settings.pref_initial_load) {
            Mainloop.timeout_add(5000, function() {
                Util.spawnCommandLine("notify-send --icon=dialog-information \"" + _(metadata.name) +
                    "\" \"" + msg.join(" ") + "\" -u critical");
                settings.pref_initial_load = true;
            });
        }
    } else
        informAndDisable();
}

/**
 * Called when extension gets disabled
 */
function disable() {
    CT_AppletManagerPatch.disable();
    CT_DeskletManagerPatch.disable();
    CT_MessageTrayPatch.disable();
    CT_WindowDemandsAttentionBehavior.disable();
    CT_TooltipsPatch.disable();
}
