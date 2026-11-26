(function(){
"use strict";
const $=id=>document.getElementById(id);
const page=document.body.dataset.page||"login";
const token=new URLSearchParams(location.search).get("token")||"";
const isNewPassword=page==="reset"&&Boolean(token);
const view=page==="signup"?"signup":page==="reset"?(isNewPassword?"newPassword":"requestReset"):"login";
const data={
 login:{title:"Welcome back",intro:"Sign in to your AERLON account.",eyebrow:"YOUR ACCOUNT",image:"https://images.unsplash.com/photo-1539109136881-3be0616acf4b?auto=format&fit=crop&w=1100&q=85"},
 signup:{title:"Create your account",intro:"Join AERLON for a seamless shopping experience.",eyebrow:"CREATE ACCOUNT",image:"https://images.unsplash.com/photo-1483985988355-763728e1935b?auto=format&fit=crop&w=1100&q=85"},
 requestReset:{title:"Reset your password",intro:"Enter your account email and we'll send a secure reset link.",eyebrow:"ACCOUNT SECURITY",image:"https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=1100&q=85"},
 newPassword:{title:"Set a new password",intro:"Create a new password to securely access your account.",eyebrow:"ACCOUNT SECURITY",image:"https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=1100&q=85"}
};
const config=data[view];$("authHeading").textContent=config.title;$("authIntro").textContent=config.intro;$("authEyebrow").textContent=config.eyebrow;$("editorialPhoto").src=config.image;$("editorialPhoto").alt="AERLON fashion editorial";
document.querySelectorAll(".auth-form").forEach(form=>form.hidden=form.dataset.view!==view);
const message=$("authMessage");
function notice(text,success=false){message.textContent=text;message.className=success?"auth-success":"auth-error";message.hidden=false;message.setAttribute("role",success?"status":"alert");}
function clearNotice(){message.hidden=true;message.textContent="";}
function validPass(p){return p.length>=8&&p.length<=200;}
function getNext(){const n=new URLSearchParams(location.search).get("next");if(!n||!n.startsWith("/")||n.startsWith("//")||n.includes("\\"))return "/";return n;}
function shopUrl(){const n=getNext();return n.startsWith("/login")||n.startsWith("/signup")||n.startsWith("/reset-password")?"/":n;}
async function send(endpoint,payload){
 const response=await fetch(endpoint,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify(payload)});
 const body=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(body.error||body.message||"We couldn't complete your request. Please try again.");
 return body;
}
function bindForm(id,endpoint,payloadFn,successFn){
 const form=$(id);if(!form)return;
 form.addEventListener("submit",async e=>{
  e.preventDefault();clearNotice();
  let payload;
  try{payload=payloadFn()}catch(err){notice(err.message);return}
  const button=form.querySelector('button[type="submit"]');
  button.disabled=true;const label=button.textContent;button.textContent="PLEASE WAIT…";
  try{const result=await send(endpoint,payload);await successFn(result)}catch(err){notice(err.message||"Please try again.")}finally{button.disabled=false;button.textContent=label;}
 });
}
document.querySelectorAll("[data-toggle-password]").forEach(button=>{
 button.addEventListener("click",()=>{
  const input=$(button.dataset.togglePassword);if(!input)return;
  const showing=input.type==="password";input.type=showing?"text":"password";
  button.setAttribute("aria-label",showing?"Hide password":"Show password");
  button.setAttribute("aria-pressed",String(showing));
 });
});
bindForm("loginForm","/api/auth/login",()=>({email:$("loginEmail").value.trim(),password:$("loginPassword").value}),async result=>{
 if(!result.user)throw Error("Sign in could not be confirmed.");
 try{localStorage.setItem("aerlon_session_v1",JSON.stringify(result.user))}catch(_){}
 location.assign(shopUrl());
});
bindForm("signupForm","/api/auth/signup",()=>{
 const p=$("signupPassword").value,confirm=$("signupConfirm").value;
 if(!validPass(p))throw Error("Use a password between 8 and 200 characters.");
 if(p!==confirm)throw Error("Passwords do not match.");
 return {name:$("signupName").value.trim(),email:$("signupEmail").value.trim(),phone:$("signupPhone").value.trim(),password:p};
},async result=>{
 if(!result.user)throw Error("We could not confirm your new account.");
 try{localStorage.setItem("aerlon_session_v1",JSON.stringify(result.user))}catch(_){}
 location.assign(shopUrl());
});
bindForm("requestResetForm","/api/auth/forgot-password",()=>({email:$("resetEmail").value.trim()}),async result=>{
 $("requestResetForm").hidden=true;
 notice(result.message||"If an account exists for this email, a reset link will be sent.",true);
 $("resetSuccessLinks").hidden=false;
});
bindForm("newPasswordForm","/api/auth/reset-password",()=>{
 const p=$("newPassword").value,confirm=$("confirmNewPassword").value;
 if(!validPass(p))throw Error("Use a password between 8 and 200 characters.");
 if(p!==confirm)throw Error("Passwords do not match.");
 return {token,password:p};
},async result=>{
 history.replaceState({},document.title,location.pathname);
 $("newPasswordForm").hidden=true;
 notice(result.message||"Your password has been updated. You can now sign in.",true);
 $("resetSuccessLinks").hidden=false;
});
if(page==="reset"&&!isNewPassword)new URLSearchParams(location.search).delete("token");
})();