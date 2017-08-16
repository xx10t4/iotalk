# iota1k

**iota1k** is a privacy-minded messaging system built on the IOTA Tangle. Each message is a transaction bundle stored in the Tangle, just like a value transfer. Messages are encrypted so only the intended recipient can read them. **iota1k** provides an easy way for users to create a public key that also act as a message address. Other users can send encrypted messages to that address, and only the recipient can read it.

This is currently very alpha-quality software. Please report issues on github. For extra safety I recommend not using an IOTA seed that has any value right now.

## Compiling

I have only compiled it on Ubuntu 16.04 and I had to install these dependencies to get electron-builder to compile the app for various platforms:
```
    # needed to compile to linux
    sudo apt install graphicsmagick
    sudo apt-get install g++-multilib

    # needed to compile to Windows
    sudo add-apt-repository ppa:ubuntu-wine/ppa
    sudo apt-get update
    sudo apt-get install wine1.8 winetricks

```

I use yarn to manage node depedencies and run the compile scipts:
```
    cd <project root dir>
    yarn install
    yarn run compile # all platforms
    yarn run compile:lin # linux
    yarn run compile:mac # mac (on Ubuntu, the '.dmg' format will be not compiled)
    yarn run compile:win # Windows 64 & 32 bit
    yarn run compile:win64 #  Windows 64 bit
    yarn run compile:win32 #  Windows 32 bit
```
