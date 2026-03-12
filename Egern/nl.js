async function main() {

const now = new Date()
const year = now.getFullYear()
const month = now.getMonth()
const today = now.getDate()

const monthName = month + 1

const weeks = ["日","一","二","三","四","五","六"]

const firstDay = new Date(year, month, 1).getDay()
const days = new Date(year, month + 1, 0).getDate()

let rows = []
let row = []

for(let i=0;i<firstDay;i++) row.push("")

for(let d=1;d<=days;d++){

row.push(d)

if(row.length===7){
rows.push(row)
row=[]
}

}

if(row.length){
while(row.length<7) row.push("")
rows.push(row)
}

let lunar="-"
let yi="-"
let ji="-"
let festival=""

try{

const resp = await $http.get({
url:`https://api.xlongwei.com/service/datetime/huangli`
})

const data = resp.data

lunar=data.lunar||"-"
yi=data.yi||"-"
ji=data.ji||"-"
festival=data.festival||""

}catch(e){}

let html=`

<div style="
font-family:-apple-system,BlinkMacSystemFont;
padding:14px;
border-radius:22px;
background:linear-gradient(135deg,#eef2ff,#f8fafc);
height:100%;
box-sizing:border-box;
">

<div style="
display:flex;
justify-content:space-between;
align-items:center;
margin-bottom:10px;
">

<div style="
font-size:22px;
font-weight:700;
color:#111;
">
${year}
</div>

<div style="
font-size:15px;
color:#555;
">
${monthName}月
</div>

</div>

<table style="
width:100%;
border-spacing:4px;
text-align:center;
font-size:12px;
">

<tr style="color:#888;font-weight:600">
${weeks.map(w=>`<td>${w}</td>`).join("")}
</tr>
`

rows.forEach(r=>{

html+="<tr>"

r.forEach(d=>{

if(d===today){

html+=`
<td>
<div style="
background:linear-gradient(135deg,#ff6b6b,#ff9966);
color:white;
border-radius:12px;
padding:7px 0;
font-weight:700;
box-shadow:0 4px 8px rgba(0,0,0,0.15);
">
${d}
</div>
</td>
`

}else if(d===""){

html+=`<td></td>`

}else{

html+=`
<td>
<div style="
background:#ffffff;
border-radius:10px;
padding:7px 0;
color:#333;
box-shadow:0 1px 3px rgba(0,0,0,0.06);
">
${d}
</div>
</td>
`

}

})

html+="</tr>"

})

html+=`

</table>

<div style="
margin-top:12px;
background:#ffffff;
border-radius:16px;
padding:10px;
box-shadow:0 2px 6px rgba(0,0,0,0.08);
">

<div style="
font-size:13px;
color:#666;
margin-bottom:6px;
">
🌙 ${lunar} ${festival}
</div>

<div style="
display:flex;
gap:6px;
flex-wrap:wrap;
margin-bottom:4px;
">

<span style="
background:#e8f7ee;
color:#16a34a;
padding:3px 8px;
border-radius:8px;
font-size:11px;
">
宜
</span>

<span style="
font-size:12px;
color:#333;
">
${yi}
</span>

</div>

<div style="
display:flex;
gap:6px;
flex-wrap:wrap;
">

<span style="
background:#fde8e8;
color:#dc2626;
padding:3px 8px;
border-radius:8px;
font-size:11px;
">
忌
</span>

<span style="
font-size:12px;
color:#333;
">
${ji}
</span>

</div>

</div>

</div>
`

$widget.setContent(html)

}

main()
