const $ = id => document.getElementById(id);
let me = null, activeId = null, conversations = [], socket = null, pendingFile = null;
async function api(url, options={}) {
  const res = await fetch(url, { credentials:"same-origin", ...options });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error || "خطایی رخ داد.");
  return data;
}
function toast(msg){const el=$("toast");el.textContent=msg;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2600)}
function showApp(user){me=user;$("loginView").classList.add("hidden");$("appView").classList.remove("hidden");$("myName").textContent=user.displayName;connectSocket();loadConversations()}
function connectSocket(){
  socket=io();
  socket.on("message:new", msg=>{if(Number(msg.conversation_id)===Number(activeId)) appendMessage(msg);loadConversations()});
  socket.on("connect_error",()=>toast("ارتباط زنده برقرار نشد؛ صفحه را تازه کنید."));
}
async function loadConversations(){
  conversations=await api("/api/conversations");
  const list=$("conversationList");list.innerHTML="";
  conversations.forEach(c=>{
    const el=document.createElement("div");el.className="conversation"+(Number(c.id)===Number(activeId)?" active":"");
    const av=document.createElement("div");av.className="avatar";av.textContent=(c.title||"هـ").slice(0,1);
    const info=document.createElement("div");info.className="conv-info";
    const title=document.createElement("b");title.textContent=c.title||"گفت‌وگو";
    const preview=document.createElement("p");preview.textContent=c.last_message|| (c.type==="group"?"گروه":"گفت‌وگوی خصوصی");
    info.append(title,preview);el.append(av,info);el.onclick=()=>openConversation(c.id);list.append(el);
  });
}
async function openConversation(id){
  activeId=Number(id);const c=conversations.find(x=>Number(x.id)===activeId);
  $("emptyState").classList.add("hidden");$("chatView").classList.remove("hidden");
  $("chatTitle").textContent=c?.title||"گفت‌وگو";$("chatAvatar").textContent=(c?.title||"هـ").slice(0,1);
  $("chatSubtitle").textContent=c?.type==="group"?"گروه همرسان":"گفت‌وگوی خصوصی";
  $("messages").innerHTML="";
  const rows=await api(`/api/conversations/${id}/messages`);rows.forEach(appendMessage);
  $("messages").scrollTop=$("messages").scrollHeight;loadConversations();
}
function appendMessage(m){
  const box=document.createElement("div");box.className="message"+(Number(m.sender_id)===Number(me.id)?" mine":"");
  if(Number(m.sender_id)!==Number(me.id)){const sender=document.createElement("div");sender.className="sender";sender.textContent=m.sender_name;box.append(sender)}
  if(m.body){const body=document.createElement("div");body.className="body";body.textContent=m.body;box.append(body)}
  if(m.attachment_path){
    const a=document.createElement("a");a.href=m.attachment_path;a.target="_blank";a.rel="noopener";a.className="attachment";a.download=m.attachment_name||"";
    const mime=m.attachment_mime||"";
    if(mime.startsWith("image/")){const img=document.createElement("img");img.src=m.attachment_path;img.alt=m.attachment_name||"تصویر";a.append(img)}
    else if(mime.startsWith("video/")){const video=document.createElement("video");video.src=m.attachment_path;video.controls=true;a.append(video)}
    else{a.className="file-link";a.textContent="📎 "+(m.attachment_name||"دریافت فایل")}
    box.append(a);
  }
  const time=document.createElement("time");time.textContent=new Date(m.created_at+"Z").toLocaleTimeString("fa-IR",{hour:"2-digit",minute:"2-digit"});box.append(time);
  $("messages").append(box);$("messages").scrollTop=$("messages").scrollHeight;
}
$("loginForm").addEventListener("submit",async e=>{e.preventDefault();$("loginError").textContent="";try{const d=await api("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:$("username").value,password:$("password").value})});showApp(d.user)}catch(err){$("loginError").textContent=err.message}});
$("logoutBtn").onclick=async()=>{await api("/api/logout",{method:"POST"});location.reload()};
$("newDirect").onclick=async()=>{
  try{const users=await api("/api/users");$("userChoices").innerHTML="";
    users.forEach(u=>{const b=document.createElement("button");b.type="button";b.className="choice";b.textContent=u.displayName+" · @"+u.username;b.onclick=async()=>{const d=await api("/api/direct",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({userId:u.id})});$("userDialog").close();await loadConversations();openConversation(d.id)};$("userChoices").append(b)});
    $("userDialog").showModal();
  }catch(e){toast(e.message)}
};
$("newGroup").onclick=async()=>{
  const users=await api("/api/users");$("groupChoices").innerHTML="";
  users.forEach(u=>{const label=document.createElement("label");label.className="choice";const cb=document.createElement("input");cb.type="checkbox";cb.value=u.id;label.append(cb,document.createTextNode(u.displayName+" · @"+u.username));$("groupChoices").append(label)});
  $("groupDialog").showModal();
};
$("cancelGroup").onclick=()=>$("groupDialog").close();
$("groupForm").onsubmit=async e=>{e.preventDefault();try{const userIds=[...$("groupChoices").querySelectorAll("input:checked")].map(x=>Number(x.value));const d=await api("/api/groups",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:$("groupTitle").value,userIds})});$("groupDialog").close();$("groupTitle").value="";await loadConversations();openConversation(d.id)}catch(err){toast(err.message)}};
$("fileInput").onchange=e=>{pendingFile=e.target.files[0];if(pendingFile)toast("فایل آماده ارسال: "+pendingFile.name)};
$("sendForm").onsubmit=async e=>{
  e.preventDefault();if(!activeId)return;
  const body=$("messageInput").value.trim();if(!body&&!pendingFile)return;
  const fd=new FormData();fd.append("body",body);if(pendingFile)fd.append("file",pendingFile);
  try{const m=await api(`/api/conversations/${activeId}/messages`,{method:"POST",body:fd});if(!socket?.connected)appendMessage(m);$("messageInput").value="";$("fileInput").value="";pendingFile=null;loadConversations()}catch(err){toast(err.message)}
};
(async()=>{try{const d=await api("/api/me");if(d.user)showApp(d.user)}catch(e){}})();
