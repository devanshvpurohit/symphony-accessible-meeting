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
    { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  ],
  iceCandidatePoolSize: 10,
};

// --- GLOBAL STATE ---
const pc = new RTCPeerConnection(servers);
let dataChannel = null;
let localStream = null;
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
  closePanelBtn: document.getElementById('closePanelBtn')
};

// --- AUTH LOGIC ---
onAuthStateChanged(auth, (user) => {
  if (user) {
    elements.loginSection.classList.add('hidden');
    elements.setupInitial.classList.remove('hidden');
    elements.userDisplayName.innerText = `Logged in as ${user.displayName}`;
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
    console.error("Login Error:", error);
    alert(`Auth Failure: ${error.message}`);
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
elements.remoteVideo.srcObject = remoteStream;

pc.ontrack = (event) => {
  event.streams[0].getTracks().forEach((track) => {
    remoteStream.addTrack(track);
  });
};

/** Shared Start Session Logic */
async function startSession() {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  elements.webcamVideo.srcObject = localStream;

  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  elements.setupOverlay.classList.add('fade-out');
  setTimeout(() => {
    elements.setupOverlay.classList.add('hidden');
    elements.mainWrapper.classList.remove('hidden');
    elements.bottomBar.classList.remove('hidden');
  }, 500);

  initSpeechRecognition();
}

/** Host: Create Meeting */
elements.webcamButton.onclick = async () => {
  try {
    await startSession();
    setupDataChannel(pc.createDataChannel('symphony-data'));

    const callDocRef = doc(collection(db, 'calls'));
    const offerCandidates = collection(callDocRef, 'offerCandidates');
    const answerCandidates = collection(callDocRef, 'answerCandidates');

    elements.displayMeetId.innerText = `CODE: ${callDocRef.id}`;

    pc.onicecandidate = (event) => {
      event.candidate && addDoc(offerCandidates, event.candidate.toJSON());
    };

    const offerDescription = await pc.createOffer();
    await pc.setLocalDescription(offerDescription);

    const offer = { sdp: offerDescription.sdp, type: offerDescription.type };
    await setDoc(callDocRef, { offer });

    // Answer listener
    onSnapshot(callDocRef, (snapshot) => {
      const data = snapshot.data();
      if (!pc.currentRemoteDescription && data?.answer) {
        pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
    });

    onSnapshot(answerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' && pc.remoteDescription) {
          pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(e => console.error(e));
        }
      });
    });

  } catch (err) {
    console.error(err);
    alert("Camera/Mic access is required.");
  }
};

/** Guest: Join Session */
elements.answerButton.onclick = async () => {
  const callId = elements.callInput.value.trim();
  if (!callId) return alert("Please enter a meeting code");

  try {
    await startSession();
    elements.displayMeetId.innerText = `CODE: ${callId}`;

    const callDocRef = doc(db, 'calls', callId);
    const answerCandidates = collection(callDocRef, 'answerCandidates');
    const offerCandidates = collection(callDocRef, 'offerCandidates');

    pc.ondatachannel = (event) => setupDataChannel(event.channel);
    pc.onicecandidate = (event) => {
      event.candidate && addDoc(answerCandidates, event.candidate.toJSON());
    };

    const callData = (await getDoc(callDocRef)).data();
    if (!callData) return alert("Symphony Session not found.");

    await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));
    const answerDescription = await pc.createAnswer();
    await pc.setLocalDescription(answerDescription);

    await updateDoc(callDocRef, { answer: { type: answerDescription.type, sdp: answerDescription.sdp } });

    onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' && pc.remoteDescription) {
          pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(e => console.error(e));
        }
      });
    });

  } catch (err) {
    console.error(err);
    alert("Could not join session.");
  }
};

// --- DATA CHANNEL & MESSAGING ---
function setupDataChannel(channel) {
  dataChannel = channel;
  dataChannel.onopen = () => appendMessage("System", "Secure stream established", false);

  dataChannel.onmessage = (event) => {
    const data = JSON.parse(event.data);
    switch (data.type) {
      case 'caption': handleIncomingCaption(data.text); break;
      case 'chat': appendMessage("Partner", data.text, false); break;
    }
  };
}

function sendChatMessage() {
  const text = elements.chatInput.value.trim();
  if (text && dataChannel?.readyState === 'open') {
    dataChannel.send(JSON.stringify({ type: 'chat', text }));
    appendMessage("You", text, true);
    elements.chatInput.value = "";
  }
}

function appendMessage(sender, text, isLocal) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-bubble ${isLocal ? 'local' : ''}`;
  msgDiv.innerHTML = `<div class="chat-bubble-name">${sender}</div><div>${text}</div>`;
  elements.chatMessages.appendChild(msgDiv);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

elements.sendChatBtn.onclick = sendChatMessage;
elements.chatInput.onkeypress = (e) => e.key === 'Enter' && sendChatMessage();

// --- ACCESSIBILITY / SPEECH ---
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
  elements.captionOverlay.classList.remove('hidden');
  clearTimeout(elements.captionOverlay.timeout);
  elements.captionOverlay.timeout = setTimeout(() => { elements.captionOverlay.classList.add('hidden'); }, 3000);
}

// --- INTERFACE CONTROLS ---
elements.muteBtn.onclick = () => {
  isMuted = !isMuted;
  localStream.getAudioTracks()[0].enabled = !isMuted;
  elements.muteBtn.classList.toggle('active', isMuted);
  elements.muteBtn.innerHTML = `<i class="fa-solid fa-microphone${isMuted ? '-slash' : ''}"></i>`;
};

elements.videoBtn.onclick = () => {
  isVideoOff = !isVideoOff;
  localStream.getVideoTracks()[0].enabled = !isVideoOff;
  elements.videoBtn.classList.toggle('active', isVideoOff);
  elements.videoBtn.innerHTML = `<i class="fa-solid fa-video${isVideoOff ? '-slash' : ''}"></i>`;
};

elements.captionBtn.onclick = () => {
  isCaptionsOn = !isCaptionsOn;
  elements.captionBtn.classList.toggle('active', isCaptionsOn);
};

elements.shareBtn.onclick = async () => {
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const sender = pc.getSenders().find(s => s.track.kind === 'video');
    sender.replaceTrack(screenStream.getVideoTracks()[0]);
    screenStream.getVideoTracks()[0].onended = () => sender.replaceTrack(localStream.getVideoTracks()[0]);
  } catch (err) { console.error(err); }
};

elements.chatBtn.onclick = () => elements.sidePanel.classList.toggle('hidden');
elements.closePanelBtn.onclick = () => elements.sidePanel.classList.add('hidden');

elements.copyBtn.onclick = () => {
  const code = elements.displayMeetId.innerText.replace('CODE: ', '');
  const url = `${window.location.origin}/?id=${code}`;
  navigator.clipboard.writeText(url).then(() => alert("Meeting Link Copied!"));
};

elements.hangupButton.onclick = () => location.reload();
