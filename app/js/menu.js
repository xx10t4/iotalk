const i18n             = require("i18next");
const {app}            = require('electron')

var buildMenu = function(electron, window) {
    const template = [
        {
            label: 'Edit',
            submenu: [
            {
                role: 'undo', label: 'Undo' //i18n.t('Undo')
            },
            {
                role: 'redo', label: i18n.t('Redo')
            },
            {
                type: 'separator'
            },
            {
                role: 'cut', label: i18n.t('Cut')
            },
            {
                role: 'copy', label: i18n.t('Copy')
            },
            {
                role: 'paste', label: i18n.t('Paste')
            },
            {
                role: 'delete', label: i18n.t('Delete')
            },
            {
                role: 'selectall', label: i18n.t('Select all')
            }
            ]
        },
        {
            label: 'View',
            submenu: [
            {
                role: 'resetzoom', label: i18n.t('Actual size')
            },
            {
                role: 'zoomin', label: i18n.t('Zoom in')
            },
            {
                role: 'zoomout', label: i18n.t('Zoom out')
            },
            {
                type: 'separator'
            },
            {
                role: 'togglefullscreen', label: i18n.t('Toggle fullscreen')
            },
            {
                label: "Developer Tools",
                accelerator: process.platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I",
                click() {
                     window.webContents.openDevTools();

                }
            }
            ]
        },
        {
            role: 'window', label: i18n.t('Window'),
            submenu: [
            {
                role: 'minimize', label: i18n.t('Minimize')
            },
            {
                role: 'close', label: i18n.t('Close')
            }
            ]
        },
        {
            role: 'help', label: i18n.t('Help'),
            submenu: [
            {
                label: "Learn More", //i18n.t('Learn more'),
                click () { electron.shell.openExternal('https://github.com/xx10t4/iota1k') }
            }
            ]
        }
    ]

    if (process.platform === 'darwin') {
        const name = app.getName()
        template.unshift({
            label: name,
            submenu: [
            {
                role: 'hide', label: i18n.t('Hide') + " " + name
            },
            {
                role: 'hideothers', label: i18n.t('Hide others')
            },
            {
                role: 'unhide', label: i18n.t('Unhide')
            },
            {
                type: 'separator'
            },
            {
                role: 'quit', label: i18n.t('Quit') + " " + name
            }
            ]
        })
        template[3].submenu = [
            {
            label: i18n.t('Close'),
            accelerator: 'CmdOrCtrl+W',
            role: 'close'
            },
            {
            label: i18n.t('Minimize'),
            accelerator: 'CmdOrCtrl+M',
            role: 'minimize'
            }
        ]
    }
    electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}

module.exports = buildMenu
