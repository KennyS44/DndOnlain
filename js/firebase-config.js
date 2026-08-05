// Конфиг проекта Firebase. Ключи здесь не секретные — доступ закрывают
// правила базы и то, что путь к комнате выводится из её ключа.
//
// databaseURL появляется после создания Realtime Database
// (Build → Realtime Database → Create Database). Пока строка пустая,
// приложение работает на локальной синхронизации между вкладками.

export const FIREBASE = {
  apiKey: 'AIzaSyAD3MmyM-Ca1ywfsRWLIrhjo_tx2ieuVQI',
  authDomain: 'dnd-dashboard-bf025.firebaseapp.com',
  databaseURL: 'https://dnd-dashboard-bf025-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'dnd-dashboard-bf025',
  storageBucket: 'dnd-dashboard-bf025.firebasestorage.app',
  messagingSenderId: '703374617184',
  appId: '1:703374617184:web:68f79d6359f0588cacb105',
};

export const useFirebase = !!FIREBASE.databaseURL;
