h1. IOTA1k

IOTA1k is a privacy-minded messaging system built on the IOTA Tangle. Each message is a transaction bundle stored in the Tangle, just like a value transfer. Messages are encrypted so only the intended recipient can read them. IOTAlk provides an easy way for users to create a public key that also act as a message address. Other users can send encrypted messages to that address, and only the recipient can read it.

This is currently very alpha-quality software. Please report issues on github. For extra safety I recommend not using an IOTA seed that has any value right now.


h1. Compiling

I have only compiled it on Ubuntu 16.04 and I had to install these dependencies to get electron-builder to compile for linux. 

Some dependencies may need to be installed:
```
    sudo apt install graphicsmagick
    sudo apt-get install g++-multilib
```

I use yarn to manage node depedencies and run the compile scipts:
```
    cd <project root dir>
    yarn install
    yarn run compile # all platforms
    yarn run compile:lin # linux
    yarn run compile:mac # mac (on Ubuntu, the '.dmg' format will not comile)
    yarn run compile:win # Windows 64 & 32 bit
    yarn run compile:win64 #  Windows 64 bit
    yarn run compile:win32 #  Windows 32 bit
```
