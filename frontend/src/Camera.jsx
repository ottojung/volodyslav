import React, { useState, useRef, useEffect } from 'react';
import JSZip from 'jszip';

export default function Camera() {
  const [currentBlob, setCurrentBlob] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [mode, setMode] = useState('camera'); // 'camera' or 'preview'
  const videoRef = useRef(null);

  // Start camera on mount
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    };
    navigator.mediaDevices.getUserMedia(constraints)
      .then((stream) => {
        video.srcObject = stream;
        video.play();
      })
      .catch((err) => {
        alert('Error accessing camera: ' + err);
      });
    return () => {
      const stream = video.srcObject;
      if (stream && stream.getTracks) {
        stream.getTracks().forEach(
          /** @param {MediaStreamTrack} track */
          (track) => track.stop()
        );
      }
    };
  }, []);

  // Add the current blob to photos list
  /**
   * @param {Blob|null} blob
   */
  const addLastPhoto = (blob) => {
    if (blob) {
      setPhotos((prev) => {
        const idx = prev.length + 1;
        const index = String(idx).padStart(2, '0');
        return [...prev, { blob, name: `photo_${index}.jpg` }];
      });
      setCurrentBlob(null);
    }
  };

  const handleTake = () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((b) => {
      if (b) {
        const url = URL.createObjectURL(b);
        setPreviewUrl(url);
        setCurrentBlob(b);
        setMode('preview');
      }
    }, 'image/jpeg', 1.0);
  };

  const handleMore = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    addLastPhoto(currentBlob);
    setMode('camera');
  };

  const handleRedo = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    setCurrentBlob(null);
    setMode('camera');
  };

  const handleDone = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    addLastPhoto(currentBlob);
    const allPhotos = currentBlob
      ? [...photos, { blob: currentBlob, name: `photo_${String(photos.length + 1).padStart(2, '0')}.jpg` }]
      : photos;
    if (allPhotos.length === 0) {
      alert('No photos to download.');
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const baseName = params.get('name')?.trim() || 'photos';
    const zipName = baseName + '.zip';
    const zip = new JSZip();
    allPhotos.forEach((p) => zip.file(p.name, p.blob));
    zip.generateAsync({ type: 'blob' }).then((zblob) => {
      const url = URL.createObjectURL(zblob);
      const a = document.createElement('a');
      a.href = url;
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 1000);
    });
  };

  return (
    <>
      <style>{`
        #camera-container {
          /* fill the entire viewport */
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          background: #000;
          color: #fff;
          font-family: sans-serif;
          overflow: hidden;
        }
        .screen {
          position: relative;
          flex: 1;
          width: 100%;
          overflow: hidden;
        }
        video, canvas, img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          background: #000;
        }
        .controls {
          position: absolute;
          bottom: 20px;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          gap: 0.5em;
          padding: 0 0.5em;
          box-sizing: border-box;
          flex-wrap: wrap;
        }
        .controls .btn {
          position: static;
          margin: 0;
          transform: none;
        }
        .btn {
          padding: 0.8em 1.6em;
          font-size: 1rem;
          border: none;
          border-radius: 5px;
          background: rgba(255,255,255,0.2);
          color: #fff;
        }
      `}</style>
      <div id="camera-container">
        <div className="screen">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            style={{ display: mode === 'camera' ? 'block' : 'none' }}
          />
          <img
            src={previewUrl}
            alt="Preview"
            style={{ display: mode === 'preview' ? 'block' : 'none' }}
          />
          <div className="controls">
            {mode === 'camera' ? (
              <>
                <button onClick={handleTake} className="btn">Take Photo</button>
                <button onClick={handleDone} className="btn">Done</button>
              </>
            ) : (
              <>
                <button onClick={handleRedo} className="btn">Redo</button>
                <button onClick={handleMore} className="btn">More</button>
                <button onClick={handleDone} className="btn">Done</button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
