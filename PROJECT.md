Create a chat software.

* This project is named Xnet, after Cory Doctorow's book Little Brother
* It is served as an SPA (one url, the html page)
* The software is a chat room, with room management
* The user can create, rename, unjoin "rooms" - they are never deleted, only unjoined
* The user can see new message count in its current rooms
* The user can enter a room, see new messages and send messages
* Messages are of any form (text, image, binary file)
* Markdown is supported
* The software will use gun.js both for backend and front-end
* It should allow : 1. one-on-one messages, encrypted with the asymetric keys available
* It should allow : 2. share rooms, upon creation by Alice, a long term symmetric encryption key is created for the room. It is stored encrypted on Alice's browser storage.  For Bob to join the shared room, he must chat privately with Alice, which sends him an invitation through one-on-one chat. If Bob accepts, then Alice decrypts the long-term symmetric encryption key and re-encrypts it with Bob asymetric key to send it to him.
* The gun.js server thus stores the one on one conversation and room messages but everything is encrypted. 
* The software MUST continue to work once the server is unavailable : as per gun.js capabilities, once the participants are connected, the server can be unavailable for some time, the sync should continue with all participants
* The software on client side MUST boot when the server is unavailable, so the SPA and all dependencies should be cached (a-la service worker). Of course if the peer discovery offered by gun.js is not available it will boot and not find peers. Meaning if the server is at least available a few seconds for peer discovery, the software runs on client side.

* The software should update all messages in near real time (not hassle the bandwidth or drain the battery, but react as fast as gun.js knows how to)
* The software should be mobile-friendly and desktop-friendly.
* Finally, the server side should be packaged as a docker image for easy deployment (for instance on render.com or vercel.com). Feel free to propose any packaging that resembles most to a one-click deploy by absolute noobs
* Ease of use is a MAJOR goal
* Encryption and usage with intermittent/disconnected server is a goal
* Per design surveillance should be impossible (or detail the process which could break privacy)

