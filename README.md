# iota1k

**iota1k** is a privacy-minded messaging system built on the IOTA Tangle. Each message is a transaction bundle stored in the Tangle, just like a value transfer. Messages are encrypted so only the intended recipient can read them. **iota1k** provides an easy way for users to create a public key that also act as a message address. Other users can send encrypted messages to that address, and only the recipient can read it.

This is currently very alpha-quality software. Please report issues on github. For extra safety I recommend not using an IOTA seed that has any value right now.


# Running Unpackaged

**iota1k** is built on Electron and Node. NPM or Yarn need to be intalled to run it.
```
cd path/to/iota1k
# install and build dependencies
yarn
# run the app
yarn run start

# or with NPM 
npm
npm run start
```

## Packaging

Right now binaries have only been compiled for linux and Windows 10. There is no reason it should not be compileable on OSX, but that has not been tested yet (pull requests welcome):
```
    # pre-steps needed to compile to linux
    sudo apt install graphicsmagick
    sudo apt-get install g++-multilib
    cd path/to/iota1k/
    npm run compile:lin

    # needed to compile on Windows 10 - run this command in gitbash as an Administrator
    npm install --global --production windows-build-tools
    cd path/to/iota1k/
    npm run compile:win

```

