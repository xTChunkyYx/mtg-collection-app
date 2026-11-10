import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getFirestore, 
  collection, 
  addDoc, 
  doc, 
  setDoc,
  updateDoc, 
  deleteDoc, 
  onSnapshot,
  query,
  where,
  writeBatch
} from 'firebase/firestore';
import { 
  getAuth, 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged 
} from 'firebase/auth';
import { 
  Search, 
  Plus, 
  Trash2, 
  ArrowLeftRight, 
  Upload, 
  Database, 
  TrendingUp, 
  PackageCheck,
  Sparkles,
  Layers,
  LogOut,
  LogIn,
  UserPlus,
  Image as ImageIcon,
  Check,
  Grid,
  List as ListIcon,
  User,
  Users,
  ArrowLeft,
  Edit3,
  X,
  FileSpreadsheet,
  Loader2,
  FolderOpen,
  FolderPlus,
  Package,
  RefreshCw
} from 'lucide-react';

// 1. Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyBMQ0tEGF7v06xvo2LeiNkVPwibJk1epEg",
  authDomain: "mtg-collection-dsmith.firebaseapp.com",
  projectId: "mtg-collection-dsmith",
  storageBucket: "mtg-collection-dsmith.firebasestorage.app",
  messagingSenderId: "836673876771",
  appId: "1:836673876771:web:2af9236da4f02c7e9a9296",
  measurementId: "G-ZKMB48LSG5"
};

// 2. Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Helper for Mana Badges
const renderManaBadges = (colors = []) => {
  if (!colors || colors.length === 0) return <span className="text-xs text-gray-400 bg-gray-800 px-2 py-0.5 rounded">Colorless</span>;
  const colorMap = {
    W: 'bg-yellow-100 text-yellow-900 border-yellow-300',
    U: 'bg-blue-600 text-white',
    B: 'bg-gray-900 text-gray-200 border-gray-700',
    R: 'bg-red-600 text-white',
    G: 'bg-emerald-600 text-white'
  };
  return (
    <div className="flex gap-1">
      {colors.map((c) => (
        <span key={c} className={`text-xs font-bold px-1.5 py-0.5 rounded border ${colorMap[c] || 'bg-gray-700 text-white'}`}>
          {c}
        </span>
      ))}
    </div>
  );
};

// Clean currency and numeric strings safely
const parseSafeNumber = (val, fallback = 0) => {
  if (typeof val === 'number') return isNaN(val) ? fallback : val;
  if (!val) return fallback;
  const cleaned = String(val).replace(/[^0-9.-]+/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? fallback : parsed;
};

// Global Scryfall CDN resolver cache & rate-limited queue to prevent HTTP 429 errors
const scryfallCdnCache = new Map();

try {
  const stored = localStorage.getItem('scryfall_cdn_cache_v1');
  if (stored) {
    const parsed = JSON.parse(stored);
    Object.entries(parsed).forEach(([k, v]) => {
      // Exclude previous fallback errors from cache so they get retried
      if (v && !v.includes('back.jpg')) {
        scryfallCdnCache.set(k, v);
      }
    });
  }
} catch (e) {}

let saveCacheTimer = null;
const debouncedSaveCdnCache = () => {
  if (saveCacheTimer) return;
  saveCacheTimer = setTimeout(() => {
    saveCacheTimer = null;
    try {
      const obj = {};
      let count = 0;
      for (const [k, v] of scryfallCdnCache.entries()) {
        if (count++ > 2500) break;
        obj[k] = v;
      }
      localStorage.setItem('scryfall_cdn_cache_v1', JSON.stringify(obj));
    } catch (e) {}
  }, 1000);
};

// Rate-limited FIFO queue with polite 150ms delay between calls & 429 backoff
class ScryfallRateLimitedQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.delayMs = 150; // Polite 150ms delay between Scryfall API calls
  }

  enqueue(cardName, setCode, onResolved) {
    const cleanName = (cardName || '').replace(/^"|"$/g, '').trim();
    const cleanSet = (setCode || '').replace(/[^a-zA-Z0-9]/g, '').trim().toLowerCase();
    const cacheKey = `${cleanName.toLowerCase()}_${cleanSet}`;

    // 1. Instant Cache Hit (0ms, 0 API calls)
    if (scryfallCdnCache.has(cacheKey)) {
      onResolved(scryfallCdnCache.get(cacheKey));
      return;
    }

    // 2. Queue for polite, rate-limited execution
    this.queue.push({ cleanName, cleanSet, cacheKey, onResolved });
    if (!this.isProcessing) {
      this.processNext();
    }
  }

  async processNext() {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      return;
    }

    this.isProcessing = true;
    const item = this.queue.shift();
    const { cleanName, cleanSet, cacheKey, onResolved } = item;

    // Check again in case a duplicate was resolved while waiting in queue
    if (scryfallCdnCache.has(cacheKey)) {
      onResolved(scryfallCdnCache.get(cacheKey));
      setTimeout(() => this.processNext(), 10);
      return;
    }

    try {
      let queryUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(cleanName)}`;
      if (cleanSet && cleanSet.length >= 3 && cleanSet.length <= 5 && cleanSet !== 'csv') {
        queryUrl += `&set=${encodeURIComponent(cleanSet)}`;
      }

      let res = await fetch(queryUrl);

      // 1. If 429 Too Many Requests, back off 2.5s and retry this item
      if (res.status === 429) {
        console.warn(`Scryfall 429 rate limit hit for "${cleanName}". Backing off 2.5s...`);
        this.queue.unshift(item);
        setTimeout(() => this.processNext(), 2500);
        return;
      }

      // 2. If 404 with set code, fallback to card name alone
      if (res.status === 404 && cleanSet && cleanSet !== 'csv') {
        res = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(cleanName)}`);
        if (res.status === 429) {
          this.queue.unshift(item);
          setTimeout(() => this.processNext(), 2500);
          return;
        }
      }

      // 3. If still 404, fallback to fuzzy search
      if (res.status === 404) {
        res = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(cleanName)}`);
        if (res.status === 429) {
          this.queue.unshift(item);
          setTimeout(() => this.processNext(), 2500);
          return;
        }
      }

      if (res.ok) {
        const data = await res.json();
        const directCdnUrl = data.image_uris?.normal || 
                             data.card_faces?.[0]?.image_uris?.normal || 
                             data.image_uris?.large || 
                             'https://cards.scryfall.io/back.jpg';
        
        if (directCdnUrl && !directCdnUrl.includes('back.jpg')) {
          scryfallCdnCache.set(cacheKey, directCdnUrl);
          debouncedSaveCdnCache();
        }
        onResolved(directCdnUrl);
      } else {
        // Fallback without poisoning cache
        onResolved('https://cards.scryfall.io/back.jpg');
      }
    } catch (err) {
      console.warn(`Failed fetching CDN image for "${cleanName}":`, err);
      onResolved('https://cards.scryfall.io/back.jpg');
    }

    // Strict 150ms delay between calls prevents Scryfall throttling
    setTimeout(() => this.processNext(), this.delayMs);
  }
}

const scryfallQueue = new ScryfallRateLimitedQueue();

// Batch resolve up to 75 cards at a time using Scryfall's official /cards/collection API
const batchResolveScryfallCards = async (cardList, onProgress = null) => {
  if (!cardList || cardList.length === 0) return new Map();

  const resultMap = new Map();
  const chunks = [];
  const chunkSize = 75; // Scryfall's official maximum per batch request

  for (let i = 0; i < cardList.length; i += chunkSize) {
    chunks.push(cardList.slice(i, i + chunkSize));
  }

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    if (onProgress) {
      onProgress(Math.round(((c + 1) / chunks.length) * 100), c + 1, chunks.length);
    }

    const identifiers = chunk.map((item) => {
      const cleanName = (item.name || '').replace(/^"|"$/g, '').trim();
      const cleanSet = (item.setCode || '').replace(/[^a-zA-Z0-9]/g, '').trim().toLowerCase();
      if (cleanSet && cleanSet.length >= 3 && cleanSet.length <= 5 && cleanSet !== 'csv') {
        return { name: cleanName, set: cleanSet };
      }
      return { name: cleanName };
    });

    try {
      const res = await fetch('https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers })
      });

      if (res.ok) {
        const json = await res.json();
        const foundCards = json.data || [];
        
        foundCards.forEach((cardObj) => {
          const cdnUrl = cardObj.image_uris?.normal || 
                         cardObj.card_faces?.[0]?.image_uris?.normal || 
                         cardObj.image_uris?.large || '';
          
          if (cdnUrl) {
            const nameKey = (cardObj.name || '').toLowerCase().trim();
            const setKey = (cardObj.set || '').toLowerCase().trim();
            resultMap.set(`${nameKey}_${setKey}`, cdnUrl);
            if (!resultMap.has(nameKey)) {
              resultMap.set(nameKey, cdnUrl);
            }
            scryfallCdnCache.set(`${nameKey}_${setKey}`, cdnUrl);
            scryfallCdnCache.set(nameKey, cdnUrl);
          }
        });

        // If some cards with a set code failed, retry them by name alone
        const notFound = json.not_found || [];
        const retryNames = notFound.filter(nf => nf.name && nf.set).map(nf => ({ name: nf.name }));
        if (retryNames.length > 0) {
          try {
            const retryRes = await fetch('https://api.scryfall.com/cards/collection', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ identifiers: retryNames })
            });
            if (retryRes.ok) {
              const retryJson = await retryRes.json();
              (retryJson.data || []).forEach((cardObj) => {
                const cdnUrl = cardObj.image_uris?.normal || 
                               cardObj.card_faces?.[0]?.image_uris?.normal || '';
                if (cdnUrl) {
                  const nameKey = (cardObj.name || '').toLowerCase().trim();
                  resultMap.set(nameKey, cdnUrl);
                  scryfallCdnCache.set(nameKey, cdnUrl);
                }
              });
            }
          } catch (e) {}
        }
      }
    } catch (err) {
      console.warn('Batch resolve chunk failed:', err);
    }

    if (c < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 100)); // Polite pause between batches
    }
  }

  debouncedSaveCdnCache();
  return resultMap;
};

// Lazy-loading card image with settle delay, rate-limited queue, retry backoff & Firestore auto-healing
const CardImage = ({ 
  src, 
  alt, 
  cardName, 
  setCode, 
  cardId, 
  className, 
  fallback = 'https://cards.scryfall.io/back.jpg' 
}) => {
  const imgRef = useRef(null);
  const [loaded, setLoaded] = useState(false);
  const [errorCount, setErrorCount] = useState(0);
  const [inView, setInView] = useState(false);
  const inViewTimerRef = useRef(null);
  const retryTimerRef = useRef(null);

  const cleanName = (cardName || alt || '').replace(/^"|"$/g, '').trim();
  const cleanSet = (setCode || '').replace(/[^a-zA-Z0-9]/g, '').trim().toLowerCase();
  const cacheKey = `${cleanName.toLowerCase()}_${cleanSet}`;

  // Initial source evaluation:
  // If already a direct cards.scryfall.io link, use it immediately
  const [resolvedUrl, setResolvedUrl] = useState(() => {
    if (src && !src.includes('api.scryfall.com')) {
      return src;
    }
    if (scryfallCdnCache.has(cacheKey)) {
      return scryfallCdnCache.get(cacheKey);
    }
    return null;
  });

  // IntersectionObserver for true lazy loading with settle delay:
  // Cards scrolled past quickly won't trigger unnecessary network requests
  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          // 120ms settle delay so fast scrolling doesn't spam requests
          inViewTimerRef.current = setTimeout(() => {
            setInView(true);
            observer.disconnect();
          }, 120);
        } else {
          if (inViewTimerRef.current) {
            clearTimeout(inViewTimerRef.current);
          }
        }
      },
      { rootMargin: '200px' } // Pre-load 200px before scrolling into viewport
    );

    observer.observe(el);
    return () => {
      if (inViewTimerRef.current) clearTimeout(inViewTimerRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      observer.disconnect();
    };
  }, []);

  // When card enters view, resolve through the rate-limited queue if not already direct CDN
  useEffect(() => {
    if (!inView) return;

    // Already direct CDN url
    if (src && !src.includes('api.scryfall.com')) {
      setResolvedUrl(src);
      return;
    }

    // Check if in cache
    if (scryfallCdnCache.has(cacheKey)) {
      const cached = scryfallCdnCache.get(cacheKey);
      setResolvedUrl(cached);
      // Auto-heal Firestore record if it still has an api.scryfall.com link
      if (cardId && src && src.includes('api.scryfall.com') && cached.includes('cards.scryfall.io')) {
        updateDoc(doc(db, 'cards', cardId), { imageUrl: cached }).catch(() => {});
      }
      return;
    }

    // Queue request through polite scheduler with delay
    if (cleanName) {
      scryfallQueue.enqueue(cleanName, cleanSet, (cdnUrl) => {
        setResolvedUrl(cdnUrl);
        // Auto-heal Firestore in background so future visits never call api.scryfall.com again
        if (cardId && cdnUrl.includes('cards.scryfall.io')) {
          updateDoc(doc(db, 'cards', cardId), { imageUrl: cdnUrl }).catch(() => {});
        }
      });
    }
  }, [inView, src, cleanName, cleanSet, cacheKey, cardId]);

  // Handle image load failure with retry delay
  const handleImageError = () => {
    if (errorCount < 2) {
      // Retry loading after a 1.5s delay
      retryTimerRef.current = setTimeout(() => {
        setErrorCount((prev) => prev + 1);
        setLoaded(false);
      }, 1500);
    } else {
      setErrorCount(99); // Max retries exceeded, will show fallback
    }
  };

  const finalSrc = errorCount >= 2 ? fallback : (resolvedUrl || fallback);

  return (
    <div ref={imgRef} className={className} style={{ backgroundColor: '#0e0f14' }}>
      {inView && resolvedUrl && errorCount < 2 ? (
        <img
          key={`${resolvedUrl}-${errorCount}`}
          src={finalSrc}
          alt={alt || cleanName}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
          onLoad={() => setLoaded(true)}
          onError={handleImageError}
          style={{ 
            opacity: loaded ? 1 : 0, 
            transition: 'opacity 0.4s ease-in-out' 
          }}
        />
      ) : null}

      {/* Loading placeholder spinner while waiting for image resolution */}
      {inView && (!loaded || !resolvedUrl) && errorCount < 2 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-950/80 backdrop-blur-[1px]">
          <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Fallback image when max retries exceeded */}
      {inView && errorCount >= 2 && (
        <img
          src={fallback}
          alt={alt || cleanName}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover opacity-80"
        />
      )}
    </div>
  );
};

export default function App() {
  // Auth State
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [authError, setAuthError] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);

  // User Profile State
  const [userProfile, setUserProfile] = useState(null);
  const [isEditingUsername, setIsEditingUsername] = useState(false);
  const [newUsername, setNewUsername] = useState('');

  // App Navigation & Data State
  const [activeTab, setActiveTab] = useState('collection');
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('grid');
  
  // Community State
  const [communityUsers, setCommunityUsers] = useState([]);
  const [allPublicCards, setAllPublicCards] = useState([]);
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [playerSearchTerm, setPlayerSearchTerm] = useState('');

  // Search & Filters for Personal Collection
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedColor, setSelectedColor] = useState('ALL');
  const [selectedRarity, setSelectedRarity] = useState('ALL');

  // Community Inspector Filters
  const [communitySearchTerm, setCommunitySearchTerm] = useState('');
  const [communityColor, setCommunityColor] = useState('ALL');
  const [communityRarity, setCommunityRarity] = useState('ALL');
  
  // Scryfall Search & Printings State
  const [queryName, setQueryName] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [availablePrintings, setAvailablePrintings] = useState([]);
  const [selectedPrinting, setSelectedPrinting] = useState(null);
  const [addQuantity, setAddQuantity] = useState(1);
  const [isFoil, setIsFoil] = useState(false);
  const [justAddedCard, setJustAddedCard] = useState(null);
  const [isAddingCard, setIsAddingCard] = useState(false);

  // CSV Import State
  const [csvText, setCsvText] = useState('');
  const [importStatus, setImportStatus] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);   // 0-100
  const [importCurrent, setImportCurrent] = useState(0);
  const [importTotal, setImportTotal] = useState(0);
  const fileInputRef = useRef(null);

  // Box / Folder State
  const [importBoxName, setImportBoxName] = useState('');       // box to import into
  const [newBoxInput, setNewBoxInput] = useState('');           // text field for creating
  const [selectedBox, setSelectedBox] = useState('ALL');        // collection filter
  const [isCreatingBox, setIsCreatingBox] = useState(false);    // show create input

  // Trade Calculator State
  const [offeredCards, setOfferedCards] = useState([]);
  const [requestedCards, setRequestedCards] = useState([]);

  // Batch Image Sync / Repair State
  const [isRepairingImages, setIsRepairingImages] = useState(false);
  const [repairStatus, setRepairStatus] = useState('');

  // Check how many cards need direct CDN image URLs
  const cardsNeedingRepair = useMemo(() => {
    return cards.filter(c => !c.imageUrl || !c.imageUrl.includes('cards.scryfall.io'));
  }, [cards]);

  const handleRepairAllImages = async () => {
    if (isRepairingImages || !user || cardsNeedingRepair.length === 0) return;
    setIsRepairingImages(true);
    setRepairStatus(`Resolving permanent CDN images for ${cardsNeedingRepair.length} cards...`);

    try {
      const resolvedMap = await batchResolveScryfallCards(cardsNeedingRepair, (pct, current, total) => {
        setRepairStatus(`Batch resolving images: batch ${current} of ${total} (${pct}%)...`);
      });

      setRepairStatus('Saving high-speed CDN links to Firestore database...');
      let updatedCount = 0;

      // Update in chunks of 100 via Firestore writeBatch
      for (let i = 0; i < cardsNeedingRepair.length; i += 100) {
        const batch = writeBatch(db);
        const slice = cardsNeedingRepair.slice(i, i + 100);

        slice.forEach(c => {
          const cleanName = (c.name || '').toLowerCase().trim();
          const cleanSet = (c.setCode || '').toLowerCase().trim();
          const cdnUrl = resolvedMap.get(`${cleanName}_${cleanSet}`) || resolvedMap.get(cleanName);

          if (cdnUrl) {
            batch.update(doc(db, 'cards', c.id), { imageUrl: cdnUrl });
            updatedCount++;
          }
        });

        await batch.commit();
      }

      setRepairStatus(`✅ Successfully synced and saved permanent CDN images for ${updatedCount} cards!`);
    } catch (err) {
      console.error('Image batch sync failed:', err);
      setRepairStatus(`❌ Image sync failed: ${err.message}`);
    } finally {
      setIsRepairingImages(false);
      setTimeout(() => setRepairStatus(''), 6000);
    }
  };

  // 1. Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (!currentUser) {
        setUserProfile(null);
        setLoading(false);
      }
    });
    return () => unsubscribe();
  }, []);

  // 2. Fetch or Create Current User Profile Doc
  useEffect(() => {
    if (!user) return;

    const userDocRef = doc(db, 'users', user.uid);
    const unsubscribe = onSnapshot(userDocRef, async (docSnap) => {
      if (docSnap.exists()) {
        setUserProfile(docSnap.data());
      } else {
        const defaultName = user.email ? user.email.split('@')[0] : 'GooberPlayer';
        const newProfile = {
          uid: user.uid,
          email: user.email,
          username: defaultName,
          createdAt: new Date().toISOString()
        };
        await setDoc(userDocRef, newProfile);
        setUserProfile(newProfile);
      }
    });

    return () => unsubscribe();
  }, [user]);

  // 3. Fetch cards belonging ONLY to logged-in user
  useEffect(() => {
    if (!user) {
      setCards([]);
      return;
    }

    setLoading(true);
    const q = query(collection(db, 'cards'), where("userId", "==", user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const cardsData = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
        price: parseSafeNumber(docSnap.data().price, 0.50),
        quantity: Math.max(1, parseInt(parseSafeNumber(docSnap.data().quantity, 1), 10))
      }));
      setCards(cardsData);
      setLoading(false);
    }, (error) => {
      console.error("Firestore cards snapshot error:", error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user]);

  // 4. Fetch Community Players & ALL Cards for Community Tab
  useEffect(() => {
    if (activeTab !== 'community') return;

    const unsubUsers = onSnapshot(collection(db, 'users'), (snapshot) => {
      const usersData = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data()
      }));
      setCommunityUsers(usersData);
    });

    const unsubCards = onSnapshot(collection(db, 'cards'), (snapshot) => {
      const publicData = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
        price: parseSafeNumber(docSnap.data().price, 0.50),
        quantity: Math.max(1, parseInt(parseSafeNumber(docSnap.data().quantity, 1), 10))
      }));
      setAllPublicCards(publicData);
    });

    return () => {
      unsubUsers();
      unsubCards();
    };
  }, [activeTab]);

  // Auth Handlers
  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError('');
    try {
      if (isRegistering) {
        const userCred = await createUserWithEmailAndPassword(auth, email, password);
        const finalUsername = usernameInput.trim() || email.split('@')[0];
        await setDoc(doc(db, 'users', userCred.user.uid), {
          uid: userCred.user.uid,
          email: email,
          username: finalUsername,
          createdAt: new Date().toISOString()
        });
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      setEmail('');
      setPassword('');
      setUsernameInput('');
    } catch (err) {
      setAuthError(err.message.replace('Firebase: ', ''));
    }
  };

  const handleUpdateUsername = async (e) => {
    e.preventDefault();
    if (!newUsername.trim() || !user) return;
    try {
      await setDoc(doc(db, 'users', user.uid), {
        uid: user.uid,
        email: user.email,
        username: newUsername.trim(),
        updatedAt: new Date().toISOString()
      }, { merge: true });

      setIsEditingUsername(false);
    } catch (err) {
      console.error("Failed to update username:", err);
    }
  };

  const handleLogout = () => signOut(auth);

  // Scryfall Autocomplete
  useEffect(() => {
    if (queryName.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(queryName)}`);
        const data = await res.json();
        setSearchResults(data.data || []);
      } catch (err) {
        console.error("Scryfall fetch error:", err);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [queryName]);

  // Fetch Printings for Scryfall Card (with multi-tier fallback for 100% search accuracy)
  const executeSearch = async (nameToSearch = queryName) => {
    const cleanName = (nameToSearch || '').trim();
    if (!cleanName) return;

    setQueryName(cleanName);
    setSearchResults([]);
    setIsSearching(true);
    setSearchError('');
    setAvailablePrintings([]);
    setSelectedPrinting(null);

    try {
      // 1. Try exact prints search
      let res = await fetch(`https://api.scryfall.com/cards/search?q=exact%3A%22${encodeURIComponent(cleanName)}%22+unique%3Aprints`);
      let searchData = await res.json();

      // 2. Fallback to loose prints search
      if (!searchData.data || searchData.data.length === 0) {
        res = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(cleanName)}+unique%3Aprints`);
        searchData = await res.json();
      }

      // 3. Fallback to fuzzy named lookup
      if (!searchData.data || searchData.data.length === 0) {
        res = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(cleanName)}`);
        const singleCard = await res.json();
        if (singleCard && singleCard.id) {
          if (singleCard.prints_search_uri) {
            const pRes = await fetch(singleCard.prints_search_uri);
            const pData = await pRes.json();
            searchData = { data: pData.data || [singleCard] };
          } else {
            searchData = { data: [singleCard] };
          }
        }
      }

      if (searchData.data && searchData.data.length > 0) {
        setAvailablePrintings(searchData.data);
        setSelectedPrinting(searchData.data[0]);
      } else {
        setSearchError(`No cards found matching "${cleanName}". Check the spelling and try again.`);
      }
    } catch (err) {
      console.error("Scryfall printings fetch error:", err);
      setSearchError("Failed to fetch card printings from Scryfall.");
    } finally {
      setIsSearching(false);
    }
  };

  const handleSelectCardName = (name) => {
    executeSearch(name);
  };

  // Add Card to Firestore with Box assignment & Rich Visual Feedback
  const handleAddCardToCollection = async () => {
    if (!selectedPrinting || !user || isAddingCard) return;
    setIsAddingCard(true);

    try {
      const normalPrice = parseSafeNumber(selectedPrinting.prices?.usd, 0.50);
      const foilPrice = parseSafeNumber(selectedPrinting.prices?.usd_foil, normalPrice);
      const finalPrice = isFoil ? foilPrice : normalPrice;

      const imageUrl = selectedPrinting.image_uris?.normal || 
                       selectedPrinting.card_faces?.[0]?.image_uris?.normal || 
                       selectedPrinting.image_uris?.large || '';

      const targetBox = importBoxName.trim() || '';
      const qtyToAdd = Math.max(1, parseInt(addQuantity, 10) || 1);

      const existingIndex = cards.findIndex(c => 
        c.name.toLowerCase() === selectedPrinting.name.toLowerCase() && 
        c.setCode === selectedPrinting.set?.toUpperCase() &&
        c.isFoil === isFoil &&
        (c.boxName || '') === targetBox
      );

      if (existingIndex > -1) {
        const existingCard = cards[existingIndex];
        const cardRef = doc(db, 'cards', existingCard.id);
        await updateDoc(cardRef, {
          quantity: existingCard.quantity + qtyToAdd,
          price: finalPrice,
          imageUrl: imageUrl || existingCard.imageUrl
        });
      } else {
        await addDoc(collection(db, 'cards'), {
          userId: user.uid,
          name: selectedPrinting.name,
          setName: selectedPrinting.set_name || 'Unknown Set',
          setCode: selectedPrinting.set?.toUpperCase() || 'MTG',
          collectorNumber: selectedPrinting.collector_number || '',
          quantity: qtyToAdd,
          price: finalPrice,
          colors: selectedPrinting.colors || selectedPrinting.color_identity || [],
          rarity: selectedPrinting.rarity || 'common',
          typeLine: selectedPrinting.type_line || '',
          imageUrl: imageUrl,
          isFoil: isFoil,
          boxName: targetBox,
          addedAt: new Date().toISOString()
        });
      }

      // Visual confirmation banner
      setJustAddedCard({
        name: selectedPrinting.name,
        setName: selectedPrinting.set_name,
        setCode: selectedPrinting.set?.toUpperCase(),
        imageUrl: imageUrl,
        quantity: qtyToAdd,
        price: finalPrice,
        isFoil: isFoil,
        boxName: targetBox
      });

      // Clear search inputs
      setQueryName('');
      setSelectedPrinting(null);
      setAvailablePrintings([]);
      setAddQuantity(1);
      setIsFoil(false);
    } catch (err) {
      console.error("Failed adding card:", err);
    } finally {
      setIsAddingCard(false);
    }
  };

  const handleDeleteCard = async (cardId) => {
    await deleteDoc(doc(db, 'cards', cardId));
  };

  // --- REFINED CSV LINE PARSER ---
  const parseCsvLine = (line) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  const getColValue = (rowParts, headers, possibleKeys) => {
    // 1. Exact match search first
    for (const key of possibleKeys) {
      const exactIdx = headers.findIndex(h => h === key);
      if (exactIdx !== -1 && rowParts[exactIdx] !== undefined) {
        return rowParts[exactIdx].replace(/^"|"$/g, '').trim();
      }
    }
    // 2. Substring match fallback
    for (const key of possibleKeys) {
      const partialIdx = headers.findIndex(h => h.includes(key));
      if (partialIdx !== -1 && rowParts[partialIdx] !== undefined) {
        return rowParts[partialIdx].replace(/^"|"$/g, '').trim();
      }
    }
    return '';
  };

  const processCsvContent = async (rawText, fileName = '', boxName = '') => {
    if (!rawText || !rawText.trim() || !user || isImporting) return;
    setIsImporting(true);
    setImportProgress(0);
    setImportCurrent(0);
    setImportTotal(0);
    const targetBox = boxName.trim() || importBoxName.trim() || '';
    setImportStatus(`Parsing & importing cards${targetBox ? ` into box "${targetBox}"` : ''}...`);

    try {
      const lines = rawText.trim().split(/\r\n|\n/);
      if (lines.length === 0) return;

      const parsedHeaderRow = parseCsvLine(lines[0]);
      const headerLine = lines[0].toLowerCase();
      const hasHeaders = headerLine.includes('name') || headerLine.includes('card') || headerLine.includes('count') || headerLine.includes('edition');
      
      const startIndex = hasHeaders ? 1 : 0;
      const headers = hasHeaders ? parsedHeaderRow.map(h => h.toLowerCase().trim().replace(/^"|"$/g, '')) : [];

      // Step 1: Parse all valid cards from CSV
      const parsedCards = [];
      for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const rowParts = parseCsvLine(line);
        if (rowParts.length === 0 || !rowParts[0]) continue;

        let name = '';
        let quantity = 1;
        let setName = 'Imported Set';
        let setCode = '';
        let price = 0.50;
        let isFoilEntry = false;
        let rarity = 'rare';
        let directCdn = '';

        if (hasHeaders) {
          name = getColValue(rowParts, headers, ['name', 'card name', 'product name', 'card']);
          quantity = parseSafeNumber(getColValue(rowParts, headers, ['count', 'qty', 'quantity', 'amount']), 1);
          setCode = getColValue(rowParts, headers, ['edition code', 'set code', 'code']);
          setName = getColValue(rowParts, headers, ['edition', 'set name', 'set', 'expansion']) || 'Imported Set';
          price = parseSafeNumber(getColValue(rowParts, headers, ['price', 'usd', 'value', 'market', 'purchase price']), 0.50);
          rarity = getColValue(rowParts, headers, ['rarity']) || 'rare';
          const foilVal = getColValue(rowParts, headers, ['foil', 'finish']).toLowerCase();
          isFoilEntry = foilVal.includes('foil') || foilVal === 'yes' || foilVal === 'true' || foilVal === '1';

          // Check if CSV exports direct Scryfall ID (ManaBox, Moxfield, Archidekt, etc.)
          const scryId = getColValue(rowParts, headers, ['scryfall id', 'scryfall_id', 'id']);
          if (scryId && scryId.length === 36) {
            directCdn = `https://cards.scryfall.io/normal/front/${scryId[0]}/${scryId[1]}/${scryId}.jpg`;
          }
        } else {
          name = rowParts[0].replace(/^"|"$/g, '').trim();
          quantity = parseSafeNumber(rowParts[1], 1);
          setName = rowParts[2] ? rowParts[2].replace(/^"|"$/g, '').trim() : 'Imported Binder';
          price = parseSafeNumber(rowParts[3], 0.50);
        }

        if (name && !isNaN(quantity) && quantity > 0) {
          const cleanSet = (setCode && setCode.length >= 3 && setCode.length <= 5 && setCode !== 'CSV') ? setCode.toLowerCase().trim() : '';
          const cacheKey = `${name.toLowerCase().trim()}_${cleanSet}`;
          const cachedCdn = directCdn || scryfallCdnCache.get(cacheKey) || scryfallCdnCache.get(name.toLowerCase().trim()) || '';

          parsedCards.push({
            name,
            setName,
            setCode: setCode || 'CSV',
            quantity,
            price,
            rarity: rarity.toLowerCase(),
            isFoil: isFoilEntry,
            imageUrl: cachedCdn
          });
        }
      }

      setImportTotal(parsedCards.length);

      // Step 2: Batch-resolve any missing CDN images via /cards/collection (75 at a time)
      const needResolution = parsedCards.filter(c => !c.imageUrl);
      if (needResolution.length > 0) {
        setImportStatus(`Batch resolving ${needResolution.length} images via Scryfall Batch API (bypassing rate limits)...`);
        const resolvedMap = await batchResolveScryfallCards(needResolution, (pct) => {
          setImportProgress(Math.round(pct * 0.4)); // First 40% of progress
        });

        parsedCards.forEach(c => {
          if (!c.imageUrl) {
            const cleanName = c.name.toLowerCase().trim();
            const cleanSet = c.setCode.toLowerCase().trim();
            c.imageUrl = resolvedMap.get(`${cleanName}_${cleanSet}`) || resolvedMap.get(cleanName) || '';
          }
        });
      }

      // Step 3: Save cards into Firestore with permanent CDN URLs
      setImportStatus(`Saving ${parsedCards.length} cards with permanent CDN images...`);
      let addedCount = 0;

      for (let i = 0; i < parsedCards.length; i++) {
        const c = parsedCards[i];
        await addDoc(collection(db, 'cards'), {
          userId: user.uid,
          name: c.name,
          setName: c.setName,
          setCode: c.setCode,
          quantity: c.quantity,
          price: c.price,
          colors: ['C'],
          rarity: c.rarity,
          typeLine: 'Imported Card',
          imageUrl: c.imageUrl,
          isFoil: c.isFoil,
          boxName: targetBox,
          addedAt: new Date().toISOString()
        });
        addedCount++;
        setImportCurrent(addedCount);
        setImportProgress(40 + Math.round(((i + 1) / parsedCards.length) * 60));
      }

      setCsvText('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      
      const sourceLabel = fileName ? `from file "${fileName}"` : 'from pasted CSV text';
      const boxLabel = targetBox ? ` into box "${targetBox}"` : '';
      setImportStatus(`✅ Successfully imported ${addedCount} cards${boxLabel} ${sourceLabel}!`);
      setImportProgress(100);
    } catch (err) {
      console.error("CSV Import Error:", err);
      setImportStatus(`❌ Import failed: ${err.message}`);
    } finally {
      setIsImporting(false);
      setTimeout(() => {
        setImportStatus('');
        setImportProgress(0);
        setImportCurrent(0);
        setImportTotal(0);
      }, 6000);
    }
  };

  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    if (!file || isImporting) return;

    setImportStatus(`Reading file "${file.name}"...`);
    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target.result;
      await processCsvContent(text, file.name, importBoxName);
    };
    reader.readAsText(file);
  };

  // Derive unique box names from all cards
  const allBoxNames = useMemo(() => {
    const names = cards.map(c => c.boxName || '').filter(Boolean);
    return [...new Set(names)].sort();
  }, [cards]);

  // Personal Filtered Cards
  const filteredCards = cards.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                          c.setName.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesColor = selectedColor === 'ALL' || (c.colors && c.colors.includes(selectedColor));
    const matchesRarity = selectedRarity === 'ALL' || c.rarity.toLowerCase() === selectedRarity.toLowerCase();
    const matchesBox = selectedBox === 'ALL' || (c.boxName || '') === selectedBox ||
                       (selectedBox === '__NONE__' && !c.boxName);
    return matchesSearch && matchesColor && matchesRarity && matchesBox;
  });

  // Personal Metrics
  const totalCardsCount = useMemo(() => {
    return cards.reduce((acc, c) => acc + (Number(c.quantity) || 1), 0);
  }, [cards]);

  const totalValue = useMemo(() => {
    const sum = cards.reduce((acc, c) => {
      const q = Number(c.quantity) || 1;
      const p = parseSafeNumber(c.price, 0);
      return acc + (q * p);
    }, 0);
    return sum.toFixed(2);
  }, [cards]);

  // Selected Community Player Cards
  const selectedPlayerCards = useMemo(() => {
    if (!selectedPlayer) return [];
    return allPublicCards.filter(c => c.userId === selectedPlayer.uid);
  }, [selectedPlayer, allPublicCards]);

  const filteredCommunityPlayerCards = useMemo(() => {
    return selectedPlayerCards.filter((c) => {
      const matchesSearch = c.name.toLowerCase().includes(communitySearchTerm.toLowerCase()) || 
                            c.setName.toLowerCase().includes(communitySearchTerm.toLowerCase());
      const matchesColor = communityColor === 'ALL' || (c.colors && c.colors.includes(communityColor));
      const matchesRarity = communityRarity === 'ALL' || c.rarity.toLowerCase() === communityRarity.toLowerCase();
      return matchesSearch && matchesColor && matchesRarity;
    });
  }, [selectedPlayerCards, communitySearchTerm, communityColor, communityRarity]);

  // Trade Calculator Totals
  const offeredTotal = offeredCards.reduce((acc, c) => acc + (parseSafeNumber(c.price, 0) * (c.tradeQty || 1)), 0).toFixed(2);
  const requestedTotal = requestedCards.reduce((acc, c) => acc + (parseSafeNumber(c.price, 0) * (c.tradeQty || 1)), 0).toFixed(2);
  const tradeDelta = (offeredTotal - requestedTotal).toFixed(2);

  // Authentication View
  if (!user) {
    return (
      <div className="min-h-screen w-full bg-gray-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-gray-900 border border-gray-800 rounded-2xl p-8 space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-flex p-3 bg-indigo-600 rounded-xl shadow-lg shadow-indigo-500/30 mb-2">
              <Layers className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-white">Goober box</h1>
            <p className="text-sm text-gray-400">
              {isRegistering ? 'Create a Goober box account to trade & manage cards' : 'Sign in to access your Goober box'}
            </p>
          </div>

          <form onSubmit={handleAuth} className="space-y-4">
            {isRegistering && (
              <div>
                <label className="text-xs text-gray-400 font-medium">Community Username</label>
                <input
                  type="text"
                  required
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  placeholder="e.g. GooberKing99"
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 mt-1"
                />
              </div>
            )}

            <div>
              <label className="text-xs text-gray-400 font-medium">Email Address</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="planeswalker@magic.com"
                className="w-full bg-gray-950 border border-gray-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 mt-1"
              />
            </div>

            <div>
              <label className="text-xs text-gray-400 font-medium">Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-gray-950 border border-gray-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 mt-1"
              />
            </div>

            {authError && (
              <p className="text-xs text-red-400 font-medium">{authError}</p>
            )}

            <button
              type="submit"
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm rounded-xl transition shadow-lg shadow-indigo-600/20 flex items-center justify-center gap-2"
            >
              {isRegistering ? <UserPlus className="w-4 h-4" /> : <LogIn className="w-4 h-4" />}
              {isRegistering ? 'Create Account & Username' : 'Sign In'}
            </button>
          </form>

          <div className="text-center">
            <button
              onClick={() => {
                setIsRegistering(!isRegistering);
                setAuthError('');
              }}
              className="text-xs text-indigo-400 hover:text-indigo-300 font-medium"
            >
              {isRegistering ? 'Already have an account? Sign in' : "Don't have an account? Register now"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-gray-950 text-gray-100 font-sans antialiased">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur sticky top-0 z-50">
        <div className="w-full px-4 sm:px-6 lg:px-8 py-4 flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-600 rounded-lg shadow-lg shadow-indigo-500/30">
              <Layers className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
                Goober box
              </h1>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400">
                  Tag: <strong className="text-indigo-300">@{userProfile?.username || 'GooberPlayer'}</strong>
                </span>
                <button
                  onClick={() => {
                    setNewUsername(userProfile?.username || '');
                    setIsEditingUsername(true);
                  }}
                  className="text-gray-500 hover:text-indigo-400 transition"
                  title="Change Community Tag"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <nav className="flex bg-gray-800/80 p-1 rounded-xl border border-gray-700/50">
              <button
                onClick={() => setActiveTab('collection')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                  activeTab === 'collection' ? 'bg-indigo-600 text-white shadow-md' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <Database className="w-4 h-4" /> Collection
              </button>
              <button
                onClick={() => setActiveTab('add')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                  activeTab === 'add' ? 'bg-indigo-600 text-white shadow-md' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <Plus className="w-4 h-4" /> Add / Import
              </button>
              <button
                onClick={() => setActiveTab('trade')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                  activeTab === 'trade' ? 'bg-indigo-600 text-white shadow-md' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <ArrowLeftRight className="w-4 h-4" /> Trade Calculator
              </button>
              <button
                onClick={() => {
                  setActiveTab('community');
                  setSelectedPlayer(null);
                }}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                  activeTab === 'community' ? 'bg-indigo-600 text-white shadow-md' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <Users className="w-4 h-4" /> Community
              </button>
            </nav>

            <button
              onClick={handleLogout}
              className="p-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-xl transition border border-red-500/20"
              title="Sign Out"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Edit Username Modal */}
      {isEditingUsername && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 max-w-sm w-full space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-white text-base">Change Goober Box Tag</h3>
              <button onClick={() => setIsEditingUsername(false)} className="text-gray-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleUpdateUsername} className="space-y-4">
              <div>
                <label className="text-xs text-gray-400">New Username</label>
                <input
                  type="text"
                  required
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 mt-1"
                />
              </div>
              <button
                type="submit"
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm rounded-xl transition shadow"
              >
                Save New Username
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="w-full px-4 sm:px-6 lg:px-8 py-8">
        
        {/* TAB 1: PERSONAL COLLECTION */}
        {activeTab === 'collection' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-gray-900/90 border border-gray-800 p-5 rounded-2xl flex items-center gap-4">
                <div className="p-3 bg-indigo-500/10 text-indigo-400 rounded-xl">
                  <PackageCheck className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-xs text-gray-400 font-medium">Total Inventory</p>
                  <p className="text-2xl font-bold text-white">{totalCardsCount} <span className="text-xs text-gray-500">cards</span></p>
                </div>
              </div>

              <div className="bg-gray-900/90 border border-gray-800 p-5 rounded-2xl flex items-center gap-4">
                <div className="p-3 bg-emerald-500/10 text-emerald-400 rounded-xl">
                  <TrendingUp className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-xs text-gray-400 font-medium">Estimated Collection Value</p>
                  <p className="text-2xl font-bold text-emerald-400">${totalValue}</p>
                </div>
              </div>

              <div className="bg-gray-900/90 border border-gray-800 p-5 rounded-2xl flex items-center gap-4">
                <div className="p-3 bg-purple-500/10 text-purple-400 rounded-xl">
                  <Sparkles className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-xs text-gray-400 font-medium">Unique Titles</p>
                  <p className="text-2xl font-bold text-white">{cards.length}</p>
                </div>
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 p-4 rounded-2xl flex flex-col md:flex-row gap-4 justify-between items-center">
              <div className="relative w-full md:w-96">
                <Search className="w-4 h-4 absolute left-3 top-3 text-gray-500" />
                <input
                  type="text"
                  placeholder="Search card name or set..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full bg-gray-950 border border-gray-800 rounded-xl pl-9 pr-4 py-2 text-sm focus:outline-none focus:border-indigo-500 text-white"
                />
              </div>

              <div className="flex flex-wrap gap-3 w-full md:w-auto items-center">
                <select
                  value={selectedColor}
                  onChange={(e) => setSelectedColor(e.target.value)}
                  className="bg-gray-950 border border-gray-800 rounded-xl px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-indigo-500"
                >
                  <option value="ALL">All Colors</option>
                  <option value="W">White</option>
                  <option value="U">Blue</option>
                  <option value="B">Black</option>
                  <option value="R">Red</option>
                  <option value="G">Green</option>
                </select>

                <select
                  value={selectedRarity}
                  onChange={(e) => setSelectedRarity(e.target.value)}
                  className="bg-gray-950 border border-gray-800 rounded-xl px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-indigo-500"
                >
                  <option value="ALL">All Rarities</option>
                  <option value="common">Common</option>
                  <option value="uncommon">Uncommon</option>
                  <option value="rare">Rare</option>
                  <option value="mythic">Mythic</option>
                </select>

                {/* Box filter */}
                <select
                  value={selectedBox}
                  onChange={(e) => setSelectedBox(e.target.value)}
                  className="bg-gray-950 border border-gray-800 rounded-xl px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-indigo-500"
                >
                  <option value="ALL">All Boxes</option>
                  <option value="__NONE__">No Box</option>
                  {allBoxNames.map(name => (
                    <option key={name} value={name}>📦 {name}</option>
                  ))}
                </select>

                <div className="flex bg-gray-950 p-1 border border-gray-800 rounded-xl">
                  <button
                    onClick={() => setViewMode('grid')}
                    className={`p-1.5 rounded-lg ${viewMode === 'grid' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'}`}
                  >
                    <Grid className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setViewMode('list')}
                    className={`p-1.5 rounded-lg ${viewMode === 'list' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'}`}
                  >
                    <ListIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Sync Images Banner for cards missing CDN URLs */}
            {cardsNeedingRepair.length > 0 && (
              <div className="bg-gradient-to-r from-indigo-950/60 to-purple-950/40 border border-indigo-500/40 rounded-2xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4 shadow-lg shadow-indigo-950/30">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-indigo-600/20 text-indigo-400 rounded-xl border border-indigo-500/30">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-white flex items-center gap-2">
                      Sync Card Images ({cardsNeedingRepair.length} cards need high-speed CDN links)
                    </h4>
                    <p className="text-xs text-gray-400">
                      Resolves cards in batches of 75 using Scryfall's Collection API to bypass rate limits and save permanent Cloudflare CDN links.
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleRepairAllImages}
                  disabled={isRepairingImages}
                  className="w-full sm:w-auto px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition disabled:opacity-50 flex items-center justify-center gap-2 whitespace-nowrap shadow-lg shadow-indigo-600/30"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRepairingImages ? 'animate-spin' : ''}`} />
                  {isRepairingImages ? 'Syncing...' : `Sync All ${cardsNeedingRepair.length} Images`}
                </button>
              </div>
            )}

            {repairStatus && (
              <div className={`p-3.5 rounded-xl border text-xs font-semibold flex items-center gap-2 ${
                repairStatus.includes('❌') 
                  ? 'bg-red-500/10 border-red-500/30 text-red-400' 
                  : repairStatus.includes('✅')
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : 'bg-indigo-500/10 border-indigo-500/30 text-indigo-300'
              }`}>
                {isRepairingImages && <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />}
                {repairStatus}
              </div>
            )}

            {loading ? (
              <div className="text-center py-20 text-gray-500">Loading your collection...</div>
            ) : filteredCards.length === 0 ? (
              <div className="text-center py-20 border border-dashed border-gray-800 rounded-2xl bg-gray-900/40">
                <p className="text-gray-400 font-medium">No Magic cards found in your account.</p>
                <button
                  onClick={() => setActiveTab('add')}
                  className="mt-4 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-500 transition"
                >
                  Add Cards Now
                </button>
              </div>
            ) : viewMode === 'grid' ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {filteredCards.map((card) => (
                  <div key={card.id} className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden group hover:border-gray-700 transition flex flex-col justify-between">
                    <div className="relative bg-gray-950 aspect-[2.5/3.5] overflow-hidden">
                      <CardImage
                        cardId={card.id}
                        cardName={card.name}
                        setCode={card.setCode}
                        src={card.imageUrl}
                        alt={card.name}
                        className="absolute inset-0 w-full h-full group-hover:scale-105 transition duration-300"
                      />
                      <div className="absolute top-2 right-2 bg-gray-950/80 backdrop-blur text-xs px-2 py-1 rounded-lg font-bold border border-gray-700 text-indigo-300">
                        x{card.quantity}
                      </div>
                      {card.isFoil && (
                        <div className="absolute top-2 left-2 bg-gradient-to-r from-amber-400 to-yellow-200 text-gray-950 text-[10px] font-black px-1.5 py-0.5 rounded shadow">
                          FOIL
                        </div>
                      )}
                    </div>

                    <div className="p-3 space-y-2">
                      <div>
                        <h3 className="text-sm font-bold text-white line-clamp-1">{card.name}</h3>
                        <p className="text-xs text-gray-400">{card.setName}</p>
                        {card.boxName && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-300 bg-amber-400/10 border border-amber-400/20 px-1.5 py-0.5 rounded mt-0.5">
                            <Package className="w-2.5 h-2.5" />{card.boxName}
                          </span>
                        )}
                      </div>

                      <div className="flex justify-between items-center text-xs">
                        {renderManaBadges(card.colors)}
                        <span className="font-semibold text-emerald-400">${(parseSafeNumber(card.price, 0)).toFixed(2)}</span>
                      </div>

                      <button
                        onClick={() => handleDeleteCard(card.id)}
                        className="w-full mt-2 flex items-center justify-center gap-1 text-xs py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
                <table className="w-full text-left text-xs text-gray-300">
                  <thead className="bg-gray-950 text-gray-400 border-b border-gray-800 uppercase">
                    <tr>
                      <th className="p-3">Card Name</th>
                      <th className="p-3">Set</th>
                      <th className="p-3">Box</th>
                      <th className="p-3">Finish</th>
                      <th className="p-3">Qty</th>
                      <th className="p-3">Price</th>
                      <th className="p-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {filteredCards.map((card) => (
                      <tr key={card.id} className="hover:bg-gray-800/50">
                        <td className="p-3 font-semibold text-white">{card.name}</td>
                        <td className="p-3 text-gray-400">{card.setName}</td>
                        <td className="p-3">
                          {card.boxName ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-300 bg-amber-400/10 border border-amber-400/20 px-1.5 py-0.5 rounded">
                              <Package className="w-2.5 h-2.5" />{card.boxName}
                            </span>
                          ) : <span className="text-gray-600">—</span>}
                        </td>
                        <td className="p-3">
                          {card.isFoil ? (
                            <span className="text-[10px] bg-amber-400/20 text-amber-300 font-bold px-1.5 py-0.5 rounded border border-amber-400/30">FOIL</span>
                          ) : 'Normal'}
                        </td>
                        <td className="p-3 font-bold text-white">{card.quantity}</td>
                        <td className="p-3 text-emerald-400 font-semibold">${(parseSafeNumber(card.price, 0)).toFixed(2)}</td>
                        <td className="p-3 text-right">
                          <button onClick={() => handleDeleteCard(card.id)} className="text-red-400 hover:text-red-300">
                            <Trash2 className="w-4 h-4 inline" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: ADD & ART VARIANT PICKER / CSV FILE & DECK IMPORT */}
        {activeTab === 'add' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Visual Feedback Banner: Shown immediately after a card is added */}
            {justAddedCard && (
              <div className="md:col-span-2 bg-gradient-to-r from-emerald-950/80 to-emerald-900/40 border border-emerald-500/50 rounded-2xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4 shadow-xl shadow-emerald-950/30">
                <div className="flex items-center gap-4">
                  {justAddedCard.imageUrl ? (
                    <img
                      src={justAddedCard.imageUrl}
                      alt={justAddedCard.name}
                      className="w-14 h-20 rounded-xl object-cover border border-emerald-500/50 shadow-md"
                    />
                  ) : (
                    <div className="w-14 h-20 bg-gray-950 rounded-xl flex items-center justify-center border border-emerald-500/50">
                      <Check className="w-8 h-8 text-emerald-400" />
                    </div>
                  )}
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="bg-emerald-500 text-gray-950 text-[10px] font-black px-2 py-0.5 rounded shadow">
                        ✓ CARD ADDED TO COLLECTION
                      </span>
                      {justAddedCard.isFoil && (
                        <span className="bg-amber-400 text-gray-950 text-[10px] font-black px-2 py-0.5 rounded shadow">
                          FOIL ✨
                        </span>
                      )}
                    </div>
                    <h3 className="text-lg font-bold text-white mt-1">
                      {justAddedCard.quantity}x {justAddedCard.name}
                    </h3>
                    <p className="text-xs text-gray-300">
                      {justAddedCard.setName} ({justAddedCard.setCode}) &bull;{' '}
                      <span className="text-emerald-400 font-semibold">${(justAddedCard.price * justAddedCard.quantity).toFixed(2)}</span>
                      {justAddedCard.boxName ? (
                        <span className="ml-2 text-amber-300 font-medium">
                          &bull; Box: "{justAddedCard.boxName}"
                        </span>
                      ) : (
                        <span className="ml-2 text-gray-400">
                          &bull; No Box (General)
                        </span>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 w-full sm:w-auto">
                  <button
                    onClick={() => setActiveTab('collection')}
                    className="flex-1 sm:flex-none px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-xl transition shadow flex items-center justify-center gap-1.5"
                  >
                    <Database className="w-3.5 h-3.5" /> View in Collection
                  </button>
                  <button
                    onClick={() => setJustAddedCard(null)}
                    className="p-2 text-gray-400 hover:text-white transition"
                    title="Dismiss"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Scryfall Art & Printing Variant Picker */}
            <div className="bg-gray-900 border border-gray-800 p-6 rounded-2xl space-y-4">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Search className="w-5 h-5 text-indigo-400" /> Search & Select Art / Printing
              </h2>
              <p className="text-xs text-gray-400">Type any card name to pick specific set art and foil finishes live from Scryfall.</p>

              <div className="relative">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      placeholder="e.g. Sol Ring, Black Lotus, Lightning Bolt..."
                      value={queryName}
                      onChange={(e) => setQueryName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          executeSearch();
                        }
                      }}
                      className="w-full bg-gray-950 border border-gray-800 rounded-xl pl-4 pr-10 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                    />
                    {queryName && (
                      <button
                        onClick={() => { setQueryName(''); setSearchResults([]); setSearchError(''); }}
                        className="absolute right-3 top-3 text-gray-500 hover:text-white"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => executeSearch()}
                    disabled={isSearching || !queryName.trim()}
                    className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-semibold transition disabled:opacity-50 flex items-center gap-1.5 shadow"
                  >
                    {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                    Search
                  </button>
                </div>

                {searchResults.length > 0 && (
                  <div className="absolute left-0 right-24 top-full mt-1 bg-gray-900 border border-gray-800 rounded-xl shadow-2xl max-h-60 overflow-y-auto z-50">
                    {searchResults.map((item) => (
                      <button
                        key={item}
                        onClick={() => executeSearch(item)}
                        className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-indigo-600 hover:text-white transition border-b border-gray-800/50 last:border-none"
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {searchError && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-400 font-medium flex items-center gap-2">
                  <X className="w-4 h-4 flex-shrink-0" />
                  {searchError}
                </div>
              )}

              {isSearching && (
                <div className="p-4 text-center text-xs text-indigo-400 flex items-center justify-center gap-2 bg-indigo-950/20 rounded-xl border border-indigo-900/30">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Searching editions & artwork from Scryfall...
                </div>
              )}

              {availablePrintings.length > 0 && (
                <div className="space-y-4 pt-2">
                  <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider flex items-center gap-1">
                    <ImageIcon className="w-4 h-4 text-indigo-400" /> Select Printing & Artwork ({availablePrintings.length} Editions)
                  </h3>

                  <div className="grid grid-cols-3 gap-3 max-h-64 overflow-y-auto pr-1">
                    {availablePrintings.map((print) => {
                      const img = print.image_uris?.small || print.card_faces?.[0]?.image_uris?.small;
                      const isSelected = selectedPrinting?.id === print.id;
                      return (
                        <div
                          key={print.id}
                          onClick={() => setSelectedPrinting(print)}
                          className={`cursor-pointer rounded-xl p-2 border transition relative ${
                            isSelected ? 'bg-indigo-950/80 border-indigo-500 ring-2 ring-indigo-500' : 'bg-gray-950 border-gray-800 hover:border-gray-700'
                          }`}
                        >
                          <img src={img || 'https://cards.scryfall.io/back.jpg'} alt={print.set_name} className="w-full h-auto rounded-lg mb-1" />
                          <p className="text-[10px] font-bold text-white truncate">{print.set_name}</p>
                          <p className="text-[9px] text-emerald-400">${print.prices?.usd || print.prices?.usd_foil || '0.50'}</p>
                          {isSelected && (
                            <div className="absolute top-1 right-1 bg-indigo-600 rounded-full p-0.5">
                              <Check className="w-3 h-3 text-white" />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {selectedPrinting && (
                <div className="p-4 bg-gray-950 border border-gray-800 rounded-xl space-y-4">
                  <div className="flex gap-4">
                    <img 
                      src={selectedPrinting.image_uris?.small || selectedPrinting.card_faces?.[0]?.image_uris?.small} 
                      alt={selectedPrinting.name} 
                      className="w-20 h-auto rounded-lg shadow-md"
                    />
                    <div className="space-y-1">
                      <h4 className="font-bold text-white">{selectedPrinting.name}</h4>
                      <p className="text-xs text-indigo-300 font-medium">{selectedPrinting.set_name} ({selectedPrinting.set?.toUpperCase()})</p>
                      <p className="text-xs text-emerald-400 font-semibold">
                        Non-Foil: ${selectedPrinting.prices?.usd || 'N/A'} | Foil: ${selectedPrinting.prices?.usd_foil || 'N/A'}
                      </p>
                      {importBoxName && (
                        <p className="text-[11px] text-amber-300 flex items-center gap-1 pt-1">
                          <Package className="w-3 h-3" />
                          Destination Box: <strong>"{importBoxName}"</strong>
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-gray-400">Qty:</label>
                      <input 
                        type="number" 
                        min="1" 
                        value={addQuantity} 
                        onChange={(e) => setAddQuantity(e.target.value)} 
                        className="w-16 bg-gray-900 border border-gray-800 rounded-lg px-2 py-1 text-sm text-center text-white"
                      />
                    </div>

                    <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                      <input 
                        type="checkbox" 
                        checked={isFoil} 
                        onChange={(e) => setIsFoil(e.target.checked)} 
                        className="rounded bg-gray-900 border-gray-700 text-indigo-600 focus:ring-indigo-500"
                      />
                      Foil Finish ✨
                    </label>
                  </div>

                  <button
                    onClick={handleAddCardToCollection}
                    disabled={isAddingCard}
                    className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm rounded-xl transition shadow-lg shadow-indigo-600/20 flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {isAddingCard ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Adding to Collection...
                      </>
                    ) : (
                      <>
                        <Plus className="w-4 h-4" />
                        Add Selected Printing to Collection
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>

            {/* CSV File Upload & Text Import Section */}
            <div className="bg-gray-900 border border-gray-800 p-6 rounded-2xl space-y-5">
              <div>
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <Upload className="w-5 h-5 text-indigo-400" /> Import CSV File / Binder
                </h2>
                <p className="text-xs text-gray-400 mt-1">
                  Select a CSV file from your computer or paste text content. Works with Daveon's binder exports, Moxfield, ManaBox, or Archidekt CSVs.
                </p>
              </div>

              {/* ── Box / Folder Selector ── */}
              <div className="bg-gray-950 border border-gray-800 rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <FolderOpen className="w-4 h-4 text-amber-400" />
                  Import into Box
                  <span className="text-xs text-gray-500 font-normal ml-1">— group cards by physical box or binder</span>
                </div>

                <div className="flex flex-wrap gap-2">
                  {/* No box */}
                  <button
                    onClick={() => { setImportBoxName(''); setIsCreatingBox(false); }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                      importBoxName === '' && !isCreatingBox
                        ? 'bg-indigo-600 border-indigo-500 text-white'
                        : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white'
                    }`}
                  >
                    No Box (General)
                  </button>

                  {/* Existing box names derived from collection */}
                  {allBoxNames.map(name => (
                    <button
                      key={name}
                      onClick={() => { setImportBoxName(name); setIsCreatingBox(false); }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                        importBoxName === name && !isCreatingBox
                          ? 'bg-amber-500/20 border-amber-400/60 text-amber-300'
                          : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-amber-400/40 hover:text-amber-300'
                      }`}
                    >
                      <Package className="w-3 h-3" />{name}
                    </button>
                  ))}

                  {/* Create new box */}
                  <button
                    onClick={() => { setIsCreatingBox(true); setImportBoxName(''); }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                      isCreatingBox
                        ? 'bg-emerald-600/20 border-emerald-400/60 text-emerald-300'
                        : 'bg-gray-900 border-dashed border-gray-600 text-gray-500 hover:border-emerald-400/40 hover:text-emerald-400'
                    }`}
                  >
                    <FolderPlus className="w-3 h-3" /> New Box
                  </button>
                </div>

                {/* New box name input */}
                {isCreatingBox && (
                  <div className="flex gap-2 mt-1">
                    <input
                      type="text"
                      placeholder="e.g. Commander Box 1, Red Deck Box, Bulk Binder…"
                      value={newBoxInput}
                      onChange={(e) => setNewBoxInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newBoxInput.trim()) {
                          setImportBoxName(newBoxInput.trim());
                          setIsCreatingBox(false);
                        }
                      }}
                      className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500 placeholder-gray-600"
                      autoFocus
                    />
                    <button
                      onClick={() => {
                        if (newBoxInput.trim()) {
                          setImportBoxName(newBoxInput.trim());
                          setIsCreatingBox(false);
                        }
                      }}
                      disabled={!newBoxInput.trim()}
                      className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition disabled:opacity-40"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => { setIsCreatingBox(false); setNewBoxInput(''); }}
                      className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs rounded-lg transition"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {importBoxName && (
                  <p className="text-xs text-amber-300/80 flex items-center gap-1 mt-1">
                    <Package className="w-3 h-3" />
                    Cards will be imported into box: <strong className="text-amber-300">"{importBoxName}"</strong>
                  </p>
                )}
              </div>

              {/* CSV File Select Button */}
              <div className={`border-2 border-dashed transition rounded-xl p-6 text-center bg-gray-950/60 ${
                isImporting ? 'border-indigo-500/50 opacity-60 pointer-events-none' : 'border-gray-800 hover:border-indigo-500'
              }`}>
                <input
                  type="file"
                  accept=".csv"
                  ref={fileInputRef}
                  id="csvFileInput"
                  disabled={isImporting}
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <label htmlFor="csvFileInput" className="cursor-pointer space-y-2 block">
                  {isImporting ? (
                    <Loader2 className="w-10 h-10 text-indigo-400 animate-spin mx-auto" />
                  ) : (
                    <FileSpreadsheet className="w-10 h-10 text-indigo-400 mx-auto" />
                  )}
                  <span className="text-sm font-semibold text-indigo-300 block">
                    {isImporting ? 'Processing File...' : 'Select CSV File from Computer'}
                  </span>
                  <span className="text-xs text-gray-500 block">
                    Supports .csv exports with headers (Name, Count, Edition, Price, Foil)
                  </span>
                </label>
              </div>

              {/* Progress Bar — shown while importing */}
              {isImporting && importTotal > 0 && (
                <div className="space-y-2">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-indigo-300 font-medium flex items-center gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin" /> Importing cards…
                    </span>
                    <span className="text-gray-400 font-mono">
                      {importCurrent} / {importTotal} &nbsp;({importProgress}%)
                    </span>
                  </div>
                  <div className="w-full bg-gray-800 rounded-full h-3 overflow-hidden">
                    <div
                      className="bg-gradient-to-r from-indigo-500 via-purple-500 to-indigo-400 h-3 rounded-full transition-all duration-200"
                      style={{ width: `${importProgress}%` }}
                    />
                  </div>
                  {importBoxName && (
                    <p className="text-[11px] text-amber-300/70 flex items-center gap-1">
                      <Package className="w-3 h-3" /> Importing into box: "{importBoxName}"
                    </p>
                  )}
                </div>
              )}

              <div className="relative flex items-center justify-center my-2">
                <div className="border-t border-gray-800 w-full"></div>
                <span className="bg-gray-900 px-3 text-xs text-gray-500 uppercase font-bold absolute">OR PASTE RAW CSV</span>
              </div>

              <textarea
                rows="6"
                disabled={isImporting}
                placeholder={"Count, Name, Edition, Price, Foil\n1, Black Lotus, Unlimited Edition, 12500, false\n4, Sol Ring, Commander Masters, 3.50, true"}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                className="w-full bg-gray-950 border border-gray-800 rounded-xl p-3 text-xs font-mono text-gray-200 focus:outline-none focus:border-indigo-500 disabled:opacity-50"
              />

              {importStatus && (
                <div className={`p-3 rounded-xl border text-xs font-semibold flex items-center gap-2 ${
                  importStatus.includes('❌') 
                    ? 'bg-red-500/10 border-red-500/30 text-red-400' 
                    : importStatus.includes('✅')
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    : 'bg-indigo-500/10 border-indigo-500/30 text-indigo-300'
                }`}>
                  {importStatus}
                </div>
              )}

              <button
                disabled={isImporting || !csvText.trim()}
                onClick={() => processCsvContent(csvText)}
                className="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-white font-medium text-sm rounded-xl transition border border-gray-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isImporting && <Loader2 className="w-4 h-4 animate-spin" />}
                Import Pasted Text Entries
              </button>
            </div>
          </div>
        )}

        {/* TAB 3: TRADE CALCULATOR */}
        {activeTab === 'trade' && (
          <div className="space-y-6">
            <div className="bg-gray-900 border border-gray-800 p-6 rounded-2xl flex flex-col md:flex-row justify-between items-center gap-4">
              <div>
                <h2 className="text-lg font-bold text-white">Trade Value Balancer</h2>
                <p className="text-xs text-gray-400">Select cards from your collection to offer and balance market prices.</p>
              </div>

              <div className="flex items-center gap-4 bg-gray-950 px-4 py-2 rounded-xl border border-gray-800">
                <div className="text-center">
                  <p className="text-[10px] text-gray-500 uppercase font-bold">You Offer</p>
                  <p className="text-lg font-bold text-indigo-400">${offeredTotal}</p>
                </div>
                <span className="text-gray-600 font-bold">VS</span>
                <div className="text-center">
                  <p className="text-[10px] text-gray-500 uppercase font-bold">You Request</p>
                  <p className="text-lg font-bold text-purple-400">${requestedTotal}</p>
                </div>
                <div className="border-l border-gray-800 pl-4 text-center">
                  <p className="text-[10px] text-gray-500 uppercase font-bold">Difference</p>
                  <p className={`text-lg font-bold ${tradeDelta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    ${tradeDelta}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 p-6 rounded-2xl space-y-4">
              <h3 className="text-sm font-bold text-gray-300">Select Cards from Collection to Add to Trade</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 max-h-64 overflow-y-auto pr-2">
                {cards.map((card) => (
                  <button
                    key={card.id}
                    onClick={() => {
                      setOfferedCards((prev) => [
                        ...prev,
                        { ...card, tradeQty: 1 }
                      ]);
                    }}
                    className="bg-gray-950 p-2 rounded-xl border border-gray-800 hover:border-indigo-500 text-left transition text-xs"
                  >
                    <p className="font-bold text-white truncate">{card.name}</p>
                    <p className="text-emerald-400 font-semibold">${parseSafeNumber(card.price, 0).toFixed(2)}</p>
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 p-6 rounded-2xl space-y-4">
              <h3 className="text-sm font-bold text-indigo-400">Offered Cards ({offeredCards.length})</h3>
              {offeredCards.length === 0 ? (
                <p className="text-xs text-gray-500 italic">No cards added to the offer side yet.</p>
              ) : (
                <div className="space-y-2">
                  {offeredCards.map((item, idx) => (
                    <div key={idx} className="flex justify-between items-center bg-gray-950 p-3 rounded-xl border border-gray-800 text-xs">
                      <span className="font-medium text-white">{item.name}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-emerald-400 font-bold">${parseSafeNumber(item.price, 0).toFixed(2)}</span>
                        <button
                          onClick={() => setOfferedCards(offeredCards.filter((_, i) => i !== idx))}
                          className="text-red-400 hover:text-red-300"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 4: COMMUNITY PLAYER DIRECTORY & VAULT INSPECTOR */}
        {activeTab === 'community' && (
          <div className="space-y-6">
            {!selectedPlayer ? (
              <div className="space-y-6">
                <div className="bg-gray-900 border border-gray-800 p-6 rounded-2xl flex flex-col md:flex-row justify-between items-center gap-4">
                  <div>
                    <h2 className="text-lg font-bold text-white flex items-center gap-2">
                      <Users className="w-5 h-5 text-indigo-400" /> Goober Box Players
                    </h2>
                    <p className="text-xs text-gray-400">Click on any player tag to view their public collection.</p>
                  </div>

                  <div className="relative w-full md:w-80">
                    <Search className="w-4 h-4 absolute left-3 top-3 text-gray-500" />
                    <input
                      type="text"
                      placeholder="Search player tags..."
                      value={playerSearchTerm}
                      onChange={(e) => setPlayerSearchTerm(e.target.value)}
                      className="w-full bg-gray-950 border border-gray-800 rounded-xl pl-9 pr-4 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {communityUsers
                    .filter(u => (u.username || '').toLowerCase().includes(playerSearchTerm.toLowerCase()))
                    .map((player) => {
                      const playerCards = allPublicCards.filter(c => c.userId === player.uid);
                      const playerTotalCount = playerCards.reduce((sum, c) => sum + (Number(c.quantity) || 1), 0);
                      const playerVal = playerCards.reduce((sum, c) => sum + ((Number(c.quantity) || 1) * parseSafeNumber(c.price, 0)), 0).toFixed(2);
                      const isCurrentUser = player.uid === user.uid;

                      return (
                        <div
                          key={player.uid}
                          onClick={() => setSelectedPlayer(player)}
                          className={`bg-gray-900 border rounded-2xl p-5 hover:border-indigo-500 cursor-pointer transition flex flex-col justify-between group ${
                            isCurrentUser ? 'border-indigo-500/50 bg-indigo-950/20' : 'border-gray-800'
                          }`}
                        >
                          <div className="space-y-3">
                            <div className="flex items-center gap-3">
                              <div className="p-3 bg-indigo-600/20 text-indigo-400 rounded-xl border border-indigo-500/30">
                                <User className="w-6 h-6" />
                              </div>
                              <div>
                                <h3 className="font-bold text-white text-base group-hover:text-indigo-300 transition">
                                  @{player.username || 'GooberPlayer'}
                                </h3>
                                <p className="text-[10px] text-gray-500 truncate">{player.email}</p>
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-gray-800/80">
                              <div className="bg-gray-950 p-2 rounded-lg border border-gray-800/60">
                                <span className="text-gray-500 text-[10px] uppercase font-bold block">Cards</span>
                                <span className="font-bold text-white">{playerTotalCount}</span>
                              </div>
                              <div className="bg-gray-950 p-2 rounded-lg border border-gray-800/60">
                                <span className="text-gray-500 text-[10px] uppercase font-bold block">Vault Value</span>
                                <span className="font-bold text-emerald-400">${playerVal}</span>
                              </div>
                            </div>
                          </div>

                          <div className="mt-4 pt-2 text-center text-xs font-semibold text-indigo-400 group-hover:text-indigo-300 flex items-center justify-center gap-1">
                            Inspect Collection $\rightarrow$
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="bg-gray-900 border border-gray-800 p-6 rounded-2xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => setSelectedPlayer(null)}
                      className="p-2 bg-gray-800 hover:bg-gray-700 text-white rounded-xl transition flex items-center gap-1 text-xs font-medium"
                    >
                      <ArrowLeft className="w-4 h-4" /> Back to Players
                    </button>
                    <div>
                      <h2 className="text-xl font-bold text-white">
                        @{selectedPlayer.username || 'GooberPlayer'}'s Collection
                      </h2>
                      <p className="text-xs text-gray-400">Browsing public cards for trade ideas.</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="bg-gray-950 px-3 py-1.5 rounded-xl border border-gray-800 text-xs">
                      <span className="text-gray-400">Total Cards: </span>
                      <strong className="text-white">{selectedPlayerCards.reduce((sum, c) => sum + (Number(c.quantity) || 1), 0)}</strong>
                    </div>
                  </div>
                </div>

                <div className="bg-gray-900 border border-gray-800 p-4 rounded-2xl flex flex-col md:flex-row gap-4 justify-between items-center">
                  <div className="relative w-full md:w-96">
                    <Search className="w-4 h-4 absolute left-3 top-3 text-gray-500" />
                    <input
                      type="text"
                      placeholder="Search player's cards..."
                      value={communitySearchTerm}
                      onChange={(e) => setCommunitySearchTerm(e.target.value)}
                      className="w-full bg-gray-950 border border-gray-800 rounded-xl pl-9 pr-4 py-2 text-sm focus:outline-none focus:border-indigo-500 text-white"
                    />
                  </div>

                  <div className="flex flex-wrap gap-3 w-full md:w-auto">
                    <select
                      value={communityColor}
                      onChange={(e) => setCommunityColor(e.target.value)}
                      className="bg-gray-950 border border-gray-800 rounded-xl px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-indigo-500"
                    >
                      <option value="ALL">All Colors</option>
                      <option value="W">White</option>
                      <option value="U">Blue</option>
                      <option value="B">Black</option>
                      <option value="R">Red</option>
                      <option value="G">Green</option>
                    </select>

                    <select
                      value={communityRarity}
                      onChange={(e) => setCommunityRarity(e.target.value)}
                      className="bg-gray-950 border border-gray-800 rounded-xl px-3 py-2 text-sm text-gray-300 focus:outline-none focus:border-indigo-500"
                    >
                      <option value="ALL">All Rarities</option>
                      <option value="common">Common</option>
                      <option value="uncommon">Uncommon</option>
                      <option value="rare">Rare</option>
                      <option value="mythic">Mythic</option>
                    </select>
                  </div>
                </div>

                {filteredCommunityPlayerCards.length === 0 ? (
                  <div className="text-center py-20 border border-dashed border-gray-800 rounded-2xl bg-gray-900/40">
                    <p className="text-gray-400 font-medium">This player has no cards matching the selected filters.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                    {filteredCommunityPlayerCards.map((card) => (
                      <div key={card.id} className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden flex flex-col justify-between">
                        <div className="relative bg-gray-950 aspect-[2.5/3.5] overflow-hidden">
                          <CardImage
                            cardId={card.id}
                            cardName={card.name}
                            setCode={card.setCode}
                            src={card.imageUrl}
                            alt={card.name}
                            className="absolute inset-0 w-full h-full"
                          />
                          <div className="absolute top-2 right-2 bg-gray-950/80 backdrop-blur text-xs px-2 py-1 rounded-lg font-bold border border-gray-700 text-indigo-300">
                            x{card.quantity}
                          </div>
                          {card.isFoil && (
                            <div className="absolute top-2 left-2 bg-gradient-to-r from-amber-400 to-yellow-200 text-gray-950 text-[10px] font-black px-1.5 py-0.5 rounded shadow">
                              FOIL
                            </div>
                          )}
                        </div>

                        <div className="p-3 space-y-2">
                          <div>
                            <h3 className="text-sm font-bold text-white line-clamp-1">{card.name}</h3>
                            <p className="text-xs text-gray-400">{card.setName}</p>
                          </div>

                          <div className="flex justify-between items-center text-xs">
                            {renderManaBadges(card.colors)}
                            <span className="font-semibold text-emerald-400">${parseSafeNumber(card.price, 0).toFixed(2)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}