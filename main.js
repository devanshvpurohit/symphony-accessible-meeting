import './style.css';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  getDoc,
  onSnapshot
} from 'firebase/firestore';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence
} from 'firebase/auth';

// --- CONFIGURATION ---
const firebaseConfig = {
  apiKey: "AIzaSyBSp5r_LeSc9ygP6lmyFu2GErlL3P5rGko",
  authDomain: "symphony-97609.firebaseapp.com",
  projectId: "symphony-97609",
  storageBucket: "symphony-97609.firebasestorage.app",
  messagingSenderId: "987242636260",
  appId: "1:987242636260:web:27b3dd6abb379239a5ddf1",
  measurementId: "G-LFYVC5N6G2"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

const servers = {
  iceServers: [
    {
      urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
    },
  ],
  iceCandidatePoolSize: 10,
};

// --- GLOBAL STATE ---
const pc = new RTCPeerConnection(servers);
let dataChannel = null;
let localStream = null;
let screenStream = null;
let remoteStream = new MediaStream();
let recognition = null;
let isMuted = false;
let isVideoOff = false;
let isCaptionsOn = false;

// HTML Elements
const elements = {
  loginSection: document.getElementById('loginSection'),
  loginBtn: document.getElementById('loginBtn'),
  userDisplayName: document.getElementById('userDisplayName'),
  webcamButton: document.getElementById('webcamButton'),
  webcamVideo: document.getElementById('webcamVideo'),
  callInput: document.getElementById('callInput'),
  answerButton: document.getElementById('answerButton'),
  remoteVideo: document.getElementById('remoteVideo'),
  hangupButton: document.getElementById('hangupButton'),
  setupOverlay: document.getElementById('setupOverlay'),
  setupInitial: document.getElementById('setupInitial'),
  displayMeetId: document.getElementById('displayMeetId'),
  captionOverlay: document.getElementById('captionOverlay'),
  gestureCanvas: document.getElementById('gestureCanvas'),
  gestureToast: document.getElementById('gestureToast'),
  muteBtn: document.getElementById('muteBtn'),
  videoBtn: document.getElementById('videoBtn'),
  captionBtn: document.getElementById('captionBtn'),
  aslBtn: document.getElementById('aslBtn'),
  shareBtn: document.getElementById('shareBtn'),
  chatBtn: document.getElementById('chatBtn'),
  sidePanel: document.getElementById('sidePanel'),
  chatMessages: document.getElementById('chatMessages'),
  chatInput: document.getElementById('chatInput'),
  sendChatBtn: document.getElementById('sendChatBtn'),
  copyBtn: document.getElementById('copyBtn'),
  mainWrapper: document.getElementById('mainWrapper'),
  bottomBar: document.getElementById('bottomBar'),
  meetTime: document.getElementById('meetTime'),
  signapseContainer: document.getElementById('signapseContainer'),
  closePanelBtn: document.getElementById('closePanelBtn')
};

// --- AUTH LOGIC ---

onAuthStateChanged(auth, (user) => {
  if (user) {
    elements.loginSection.classList.add('hidden');
    elements.setupInitial.classList.remove('hidden');
    elements.userDisplayName.innerText = `Signed in as ${user.displayName}`;
  } else {
    elements.loginSection.classList.remove('hidden');
    elements.setupInitial.classList.add('hidden');
  }
});

elements.loginBtn.onclick = async () => {
  try {
    await setPersistence(auth, browserLocalPersistence);
    await signInWithPopup(auth, provider);
  } catch (error) {
    console.error("Login failed:", error);
    alert(`Authentication failed: ${error.message}`);
  }
};

// --- CLOCK ---
function updateClock() {
  const now = new Date();
  elements.meetTime.innerText = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(updateClock, 1000);
updateClock();

// --- WEBRTC CORE ---

// 1. Setup Remote Video once
elements.remoteVideo.srcObject = remoteStream;

pc.ontrack = (event) => {
  event.streams[0].getTracks().forEach((track) => {
    remoteStream.addTrack(track);
  });
  console.log("Remote track added to stream");
};

/** Start Meeting (Host) */
elements.webcamButton.onclick = async () => {
  try {
    // 1. Get local media
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    elements.webcamVideo.srcObject = localStream;

    // 2. Add tracks to peer connection
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });

    // 3. UI Transition
    elements.setupOverlay.classList.add('hidden');
    elements.mainWrapper.classList.remove('hidden');
    elements.bottomBar.classList.remove('hidden');

    // 4. Create Offer (Signaling)
    setupDataChannel(pc.createDataChannel('symphony-data'));

    const callDocRef = doc(collection(db, 'calls'));
    const offerCandidates = collection(callDocRef, 'offerCandidates');
    const answerCandidates = collection(callDocRef, 'answerCandidates');

    const callId = callDocRef.id;
    elements.displayMeetId.innerText = callId;

    pc.onicecandidate = (event) => {
      event.candidate && addDoc(offerCandidates, event.candidate.toJSON());
    };

    const offerDescription = await pc.createOffer();
    await pc.setLocalDescription(offerDescription);

    const offer = { sdp: offerDescription.sdp, type: offerDescription.type };
    await setDoc(callDocRef, { offer });

    // Listen for Answer
    onSnapshot(callDocRef, (snapshot) => {
      const data = snapshot.data();
      if (!pc.currentRemoteDescription && data?.answer) {
        pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
    });

    // Listen for Answer Candidates
    onSnapshot(answerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' && pc.remoteDescription) {
          pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(e => console.error(e));
        }
      });
    });

    initGestureRecognition();
    initSpeechRecognition();
  } catch (err) {
    console.error("Error starting meeting:", err);
    alert("Camera/Mic access is required to host a meeting.");
  }
};

/** Join Meeting (Guest) */
elements.answerButton.onclick = async () => {
  const callId = elements.callInput.value.trim();
  if (!callId) return alert("Please enter a Meeting ID");

  try {
    // 1. Get local media
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    elements.webcamVideo.srcObject = localStream;

    // 2. Add tracks
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });

    // 3. UI Transition
    elements.setupOverlay.classList.add('hidden');
    elements.mainWrapper.classList.remove('hidden');
    elements.bottomBar.classList.remove('hidden');
    elements.displayMeetId.innerText = callId;

    // 4. Signaling (Join)
    const callDocRef = doc(db, 'calls', callId);
    const answerCandidates = collection(callDocRef, 'answerCandidates');
    const offerCandidates = collection(callDocRef, 'offerCandidates');

    pc.ondatachannel = (event) => {
      setupDataChannel(event.channel);
    };

    pc.onicecandidate = (event) => {
      event.candidate && addDoc(answerCandidates, event.candidate.toJSON());
    };

    const callData = (await getDoc(callDocRef)).data();
    if (!callData) return alert("Call not found. Check the ID.");

    await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));
    const answerDescription = await pc.createAnswer();
    await pc.setLocalDescription(answerDescription);

    await updateDoc(callDocRef, { answer: { type: answerDescription.type, sdp: answerDescription.sdp } });

    // Listen for Offer Candidates
    onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' && pc.remoteDescription) {
          pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(e => console.error(e));
        }
      });
    });

    initGestureRecognition();
    initSpeechRecognition();
  } catch (err) {
    console.error("Error joining meeting:", err);
    alert("Camera/Mic access is required to join.");
  }
};

// --- DATA CHANNEL & CHAT ---

function setupDataChannel(channel) {
  dataChannel = channel;
  dataChannel.onopen = () => appendMessage("System", "Chat connected");

  dataChannel.onmessage = (event) => {
    const data = JSON.parse(event.data);
    switch (data.type) {
      case 'caption': handleIncomingCaption(data.text); break;
      case 'gesture': handleIncomingGesture(data.gesture); break;
      case 'chat': appendMessage("Participant", data.text); break;
    }
  };
}

function sendChatMessage() {
  const text = elements.chatInput.value.trim();
  if (text && dataChannel?.readyState === 'open') {
    dataChannel.send(JSON.stringify({ type: 'chat', text }));
    appendMessage("You", text);
    elements.chatInput.value = "";
  }
}

function appendMessage(sender, text) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'chat-bubble';
  msgDiv.innerHTML = `<div class="chat-bubble-name">${sender}</div><div class="chat-bubble-text">${text}</div>`;
  elements.chatMessages.appendChild(msgDiv);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

elements.sendChatBtn.onclick = sendChatMessage;
elements.chatInput.onkeypress = (e) => e.key === 'Enter' && sendChatMessage();

// --- ACCESSIBILITY ACTIONS ---

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      transcript += event.results[i][0].transcript;
    }
    if (dataChannel?.readyState === 'open') {
      dataChannel.send(JSON.stringify({ type: 'caption', text: transcript }));
    }
  };
  recognition.start();
}

function handleIncomingCaption(text) {
  if (!isCaptionsOn) return;
  elements.captionOverlay.innerText = text;
  clearTimeout(elements.captionOverlay.timeout);
  elements.captionOverlay.timeout = setTimeout(() => { elements.captionOverlay.innerText = ""; }, 4000);
}

async function initGestureRecognition() {
  const hands = new Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
  hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.7, minTrackingConfidence: 0.7 });
  hands.onResults(onHandResults);

  const camera = new Camera(elements.webcamVideo, {
    onFrame: async () => { await hands.send({ image: elements.webcamVideo }); },
    width: 640, height: 480
  });
  camera.start();
}

function onHandResults(results) {
  if (results.multiHandLandmarks?.length > 0) {
    const gesture = detectSimpleGesture(results.multiHandLandmarks[0]);
    if (gesture && gesture !== lastGesture) handleLocalGesture(gesture);
  }
}

let lastGesture = null;
let gestureCooldown = false;

const ASL_ALPHABET = {
  A: (lm) => isFolded(lm, 8) && isFolded(lm, 12) && isFolded(lm, 16) && isFolded(lm, 20) && lm[4].y < lm[3].y,
  B: (lm) => !isFolded(lm, 8) && !isFolded(lm, 12) && !isFolded(lm, 16) && !isFolded(lm, 20),
  L: (lm) => !isFolded(lm, 8) && isFolded(lm, 12) && isFolded(lm, 16) && isFolded(lm, 20) && lm[4].x < lm[3].x,
  V: (lm) => !isFolded(lm, 8) && !isFolded(lm, 12) && isFolded(lm, 16) && isFolded(lm, 20),
};

function isFolded(lm, tip) { return lm[tip].y > lm[tip - 2].y; }
function dist(p1, p2) { return Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2); }

function detectSimpleGesture(lm) {
  for (const [letter, check] of Object.entries(ASL_ALPHABET)) { if (check(lm)) return letter; }
  const isThumbUp = lm[4].y < lm[3].y && lm[4].y < lm[2].y;
  if (isThumbUp) return "YES";
  return null;
}

function handleLocalGesture(gesture) {
  if (gestureCooldown) return;
  lastGesture = gesture; gestureCooldown = true;
  elements.gestureToast.innerText = `${gesture} 👋`;
  elements.gestureToast.classList.add('show');
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(gesture));
  if (dataChannel?.readyState === 'open') dataChannel.send(JSON.stringify({ type: 'gesture', gesture }));
  setTimeout(() => { elements.gestureToast.classList.remove('show'); gestureCooldown = false; lastGesture = null; }, 3000);
}

function handleIncomingGesture(gesture) {
  elements.gestureToast.innerText = `Remote: ${gesture}`;
  elements.gestureToast.classList.add('show');
  window.speechSynthesis.speak(new SpeechSynthesisUtterance("Remote user says " + gesture));
  setTimeout(() => elements.gestureToast.classList.remove('show'), 3000);
}

// --- CONTROLS ---

elements.muteBtn.onclick = () => {
  isMuted = !isMuted;
  localStream.getAudioTracks()[0].enabled = !isMuted;
  elements.muteBtn.classList.toggle('on', !isMuted);
  elements.muteBtn.innerHTML = `<span class="material-icons">${isMuted ? 'mic_off' : 'mic'}</span>`;
};

elements.videoBtn.onclick = () => {
  isVideoOff = !isVideoOff;
  localStream.getVideoTracks()[0].enabled = !isVideoOff;
  elements.videoBtn.classList.toggle('on', !isVideoOff);
  elements.videoBtn.innerHTML = `<span class="material-icons">${isVideoOff ? 'videocam_off' : 'videocam'}</span>`;
};

elements.captionBtn.onclick = () => {
  isCaptionsOn = !isCaptionsOn;
  elements.captionBtn.classList.toggle('on', isCaptionsOn);
  if (!isCaptionsOn) elements.captionOverlay.innerText = "";
};

elements.aslBtn.onclick = () => {
  elements.signapseContainer.classList.toggle('hidden');
  elements.aslBtn.classList.toggle('on');
};

elements.shareBtn.onclick = async () => {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const sender = pc.getSenders().find(s => s.track.kind === 'video');
    sender.replaceTrack(screenStream.getVideoTracks()[0]);
    screenStream.getVideoTracks()[0].onended = () => sender.replaceTrack(localStream.getVideoTracks()[0]);
  } catch (err) { console.error(err); }
};

elements.chatBtn.onclick = () => elements.sidePanel.classList.toggle('hidden');
elements.closePanelBtn.onclick = () => elements.sidePanel.classList.add('hidden');

elements.copyBtn.onclick = () => {
  const url = `${window.location.origin}/?id=${elements.displayMeetId.innerText}`;
  navigator.clipboard.writeText(url).then(() => alert("Joining info copied"));
};

elements.hangupButton.onclick = () => location.reload();
